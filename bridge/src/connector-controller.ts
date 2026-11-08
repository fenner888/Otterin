import { networkInterfaces } from 'node:os';
import type { Readable, Writable } from 'node:stream';

import { pairingOfferSchema } from './pairing';
import {
  CONNECTOR_IPC_VERSION,
  MAXIMUM_CONNECTOR_IPC_LINE_BYTES,
  encodeConnectorEvent,
  parseConnectorCommand,
  type ConnectorEvent,
} from './connector-ipc';
import {
  createConnectorPlatformAdapter,
  selectPreferredConnectorAddress,
  type ConnectorPlatformAdapter,
} from './connector-platform';
import { safeDisplayText } from './safe-text';
import {
  createProductionRunnerDependencies,
  DesktopBridgeRunner,
  type DesktopBridgeRunnerDependencies,
} from './runner';

const CONNECTOR_EXTERNAL_PORT = 45_831;
const ACP_RECOVERY_INTERVAL_MS = 5_000;

export interface ConnectorControllerOptions {
  input: Readable;
  output: Writable;
  environment?: NodeJS.ProcessEnv;
  platform?: ConnectorPlatformAdapter;
  interfaces?: ReturnType<typeof networkInterfaces>;
  pollIntervalMs?: number;
  createRunner?: (
    options: {
      advertisedHost: string;
      bindHost?: string;
      port?: number;
      bindPort?: number;
      devinCliPath?: string;
      devinSessionDbPath?: string;
    },
    dependencies: DesktopBridgeRunnerDependencies,
  ) => DesktopBridgeRunner;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    // Keep the controller process alive while an IPC command is still settling. In particular,
    // reset closes the listener and ACP before deleting Keychain state; an unref'ed poll timer can
    // otherwise let Node exit before reset_complete reaches the native uninstall flow.
    setTimeout(resolve, milliseconds);
  });
}

export class ConnectorController {
  private readonly platform: ConnectorPlatformAdapter;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly interfaces: ReturnType<typeof networkInterfaces>;
  private readonly pollIntervalMs: number;
  private readonly createRunner: NonNullable<ConnectorControllerOptions['createRunner']>;
  private runner: DesktopBridgeRunner | null = null;
  private stopping = false;
  private offerExpiresAt = 0;
  private presentedReviewId: string | null = null;
  private inputBuffer = Buffer.alloc(0);
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly inputDataListener = (chunk: Buffer | string) => this.consumeInput(chunk);
  private readonly inputCloseListener = () => {
    this.stopping = true;
  };

  constructor(private readonly options: ConnectorControllerOptions) {
    this.platform = options.platform ?? createConnectorPlatformAdapter();
    this.environment = options.environment ?? process.env;
    this.interfaces = options.interfaces ?? networkInterfaces();
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.createRunner =
      options.createRunner ??
      ((runnerOptions, dependencies) => new DesktopBridgeRunner(runnerOptions, dependencies));
  }

  async run(): Promise<void> {
    const addresses = this.platform.discoverPrivateAddresses(this.interfaces);
    const host = selectPreferredConnectorAddress(addresses);
    const devinCliPath = await this.platform.discoverDevinCli(this.environment);
    const devinSessionDbPath = await this.platform.discoverDevinSessionDb(this.environment);
    const qrRenderer = {
      render: (payload: string) => {
        const offer = pairingOfferSchema.parse(JSON.parse(payload));
        this.offerExpiresAt = offer.expiresAt;
        this.write({
          version: CONNECTOR_IPC_VERSION,
          type: 'pairing_offer',
          payload,
          expiresAt: offer.expiresAt,
        });
      },
    };
    const dependencies = createProductionRunnerDependencies(qrRenderer, this.platform.id);
    dependencies.secretStore = this.platform.createSecretStore();
    dependencies.onPairingDiagnostic = ({ route, phase, status }) => {
      this.write({
        version: CONNECTOR_IPC_VERSION,
        type: 'pairing_diagnostic',
        route:
          route === 'request'
            ? 'protected_request'
            : route === 'pairing.submit'
              ? 'pairing_submit'
              : 'pairing_status',
        phase,
        status,
      });
    };
    const runner = this.createRunner(
      {
        advertisedHost: host,
        port: CONNECTOR_EXTERNAL_PORT,
        ...(devinCliPath ? { devinCliPath } : {}),
        ...(devinSessionDbPath ? { devinSessionDbPath } : {}),
      },
      dependencies,
    );
    this.runner = runner;
    this.options.input.on('data', this.inputDataListener);
    this.options.input.once('end', this.inputCloseListener);
    this.options.input.once('close', this.inputCloseListener);

    try {
      const started = await runner.start();
      this.write({
        version: CONNECTOR_IPC_VERSION,
        type: 'ready',
        transport: started.transportKind,
        sessionDiscoveryEnabled: started.sessionDiscoveryEnabled,
        cliDetected: Boolean(devinCliPath),
      });
      this.writeDevices();
      let sessionDiscoveryEnabled = started.sessionDiscoveryEnabled;
      let nextAcpRecoveryAt = Date.now() + ACP_RECOVERY_INTERVAL_MS;
      while (!this.stopping) {
        const review = runner.pendingReviews()[0];
        if (review && review.pairingId !== this.presentedReviewId) {
          this.presentedReviewId = review.pairingId;
          this.write({
            version: CONNECTOR_IPC_VERSION,
            type: 'pairing_review',
            pairingId: review.pairingId,
            deviceName: safeDisplayText(review.deviceName),
            deviceKeyFingerprint: review.deviceKeyFingerprint,
            expiresAt: review.expiresAt,
          });
        }
        if (Date.now() >= this.offerExpiresAt && !review) {
          this.offerExpiresAt = runner.showPairingOffer();
        }
        if (Date.now() >= nextAcpRecoveryAt) {
          nextAcpRecoveryAt = Date.now() + ACP_RECOVERY_INTERVAL_MS;
          const recovered = await runner.recoverSessionDiscovery();
          if (recovered !== sessionDiscoveryEnabled) {
            sessionDiscoveryEnabled = recovered;
            this.write({
              version: CONNECTOR_IPC_VERSION,
              type: 'ready',
              transport: started.transportKind,
              sessionDiscoveryEnabled,
              cliDetected: Boolean(devinCliPath),
            });
          }
        }
        await delay(this.pollIntervalMs);
      }
    } finally {
      this.options.input.off('data', this.inputDataListener);
      this.options.input.off('end', this.inputCloseListener);
      this.options.input.off('close', this.inputCloseListener);
      this.options.input.pause();
      this.inputBuffer.fill(0);
      this.inputBuffer = Buffer.alloc(0);
      await this.commandQueue.catch(() => {});
      const results = await Promise.allSettled([runner.stop()]);
      this.runner = null;
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Connector transport did not shut down cleanly');
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  private consumeInput(chunkInput: Buffer | string): void {
    const chunk = Buffer.isBuffer(chunkInput) ? chunkInput : Buffer.from(chunkInput, 'utf8');
    if (this.inputBuffer.length + chunk.length > MAXIMUM_CONNECTOR_IPC_LINE_BYTES) {
      this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'command_invalid' });
      this.stopping = true;
      return;
    }
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
    let newline = this.inputBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const lineBuffer = this.inputBuffer.subarray(0, newline);
      const remaining = Buffer.from(this.inputBuffer.subarray(newline + 1));
      const line = lineBuffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r$/, '');
      this.inputBuffer.fill(0);
      this.inputBuffer = remaining;
      if (line.length > 0) this.enqueueCommand(line);
      newline = this.inputBuffer.indexOf(0x0a);
    }
  }

  private enqueueCommand(line: string): void {
    this.commandQueue = this.commandQueue
      .then(async () => {
        let command;
        try {
          command = parseConnectorCommand(line);
        } catch {
          this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'command_invalid' });
          return;
        }
        const runner = this.runner;
        if (!runner) return;
        if (command.type === 'shutdown') {
          await this.stop();
          return;
        }
        if (command.type === 'reset') {
          try {
            await runner.resetPersistentState();
            this.write({ version: CONNECTOR_IPC_VERSION, type: 'reset_complete' });
          } catch {
            this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'uninstall_failed' });
          } finally {
            this.stopping = true;
          }
          return;
        }
        if (command.type === 'regenerate') {
          this.presentedReviewId = null;
          this.offerExpiresAt = runner.showPairingOffer();
          return;
        }
        if (command.type === 'deny') {
          const denied = runner.deny(command.pairingId);
          this.presentedReviewId = null;
          if (!denied) {
            this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'pairing_expired' });
          }
          this.offerExpiresAt = runner.showPairingOffer();
          return;
        }
        if (command.type === 'update_device') {
          const updated = await runner.updateDevicePermissions(command.deviceId, {
            allowSessionContent: command.allowSessionContent,
            allowSessionPrompt: command.allowSessionPrompt,
            allowSessionCreate: command.allowSessionCreate,
          });
          if (!updated) throw new Error('Paired device update was rejected');
          this.writeDevices();
          return;
        }
        if (command.type === 'revoke_device') {
          const revoked = await runner.revokeDevice(command.deviceId);
          if (!revoked) throw new Error('Paired device revocation was rejected');
          this.writeDevices();
          return;
        }
        const approved = await runner.approve(command.pairingId, {
          allowSessionContent: command.allowSessionContent,
        });
        this.presentedReviewId = null;
        if (!approved) {
          this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'pairing_expired' });
          this.offerExpiresAt = runner.showPairingOffer();
          return;
        }
        this.write({
          version: CONNECTOR_IPC_VERSION,
          type: 'pairing_complete',
          access: command.allowSessionContent ? 'read_only_content' : 'metadata_only',
        });
        this.writeDevices();
      })
      .catch(() => {
        this.write({ version: CONNECTOR_IPC_VERSION, type: 'error', code: 'pairing_failed' });
      });
  }

  private writeDevices(): void {
    const runner = this.runner;
    if (!runner) return;
    this.write({
      version: CONNECTOR_IPC_VERSION,
      type: 'devices',
      devices: runner.pairedDevices().map((device) => ({
        deviceId: device.deviceId,
        deviceName: safeDisplayText(device.deviceName),
        pairedAt: device.pairedAt,
        status: device.status,
        allowSessionContent: device.permissions.includes('session:content:read'),
        allowSessionPrompt: device.permissions.includes('session:prompt:send'),
        allowSessionCreate: device.permissions.includes('session:create'),
      })),
    });
  }

  private write(event: ConnectorEvent): void {
    this.options.output.write(encodeConnectorEvent(event));
  }
}
