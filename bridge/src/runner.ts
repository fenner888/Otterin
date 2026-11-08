import { isAbsolute, win32 } from 'node:path';
import { isIP } from 'node:net';

import { z } from 'zod';

import {
  AcpSessionClient,
  defaultActivityLabel,
  isAcpSessionInUseError,
  type AcpLoadedSession,
  type AcpElicitationResponse,
  type AcpHistoryMessage,
  type AcpModelCatalog,
  type AcpPendingElicitation,
  type AcpPendingPermission,
  type AcpSessionActivity,
  type AcpSessionTurn,
  type AcpTerminalQuestion,
} from './acp';
import { markTimedOutEntries } from './activity';
import {
  DevinSessionStore,
  type DevinCreateOptions,
  type DevinSessionPresentation,
} from './devin-session-store';
import type { HttpsBridgeListenerAddress, HttpsBridgeListenerOptions } from './listener';
import { HttpsBridgeListener } from './listener';
import { MacOSKeychainSecretStore } from './macos-keychain';
import {
  isAdvertisablePrivateAddress,
  privateTransportKind,
  type PrivateTransportKind,
} from './network';
import {
  defaultComputerName,
  PairingManager,
  type PairingApprovalOptions,
  type PendingPairingReview,
} from './pairing';
import { FixedWindowRateLimiter } from './rate-limit';
import { InMemoryReplayGuard } from './replay';
import { BridgeService, type SessionDiscoveryAdapter } from './service';
import { SessionHandleRegistry } from './session-handles';
import { WorkspaceHandleRegistry } from './workspace-handles';
import type { SecretStore } from './secret-store';
import { WindowsDpapiSecretStore } from './windows-dpapi';
import {
  DesktopBridgeStateRepository,
  loadDesktopBridgeRuntime,
  type DeviceSummary,
  type PersistentDeviceRegistry,
} from './state';
import {
  OpenSslTlsIdentityGenerator,
  WindowsTlsIdentityGenerator,
  type TlsIdentity,
  type TlsIdentityGenerator,
} from './tls-identity';

const runnerOptionsSchema = z
  .object({
    advertisedHost: z
      .string()
      .min(2)
      .max(64)
      .refine(
        isAdvertisablePrivateAddress,
        'Advertised host must be an advertisable private IP address',
      ),
    bindHost: z
      .string()
      .refine((value) => isIP(value) !== 0, 'Bind host must be an IP literal')
      .optional(),
    port: z.number().int().min(1_024).max(65_535).default(45_831),
    bindPort: z.number().int().min(1_024).max(65_535).optional(),
    devinCliPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, 'Devin CLI path must be absolute')
      .optional(),
    devinSessionDbPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, 'Devin session database path must be absolute')
      .optional(),
  })
  .strict();

export interface DesktopBridgeRunnerOptions {
  advertisedHost: string;
  bindHost?: string;
  port?: number;
  bindPort?: number;
  devinCliPath?: string;
  devinSessionDbPath?: string;
}

export interface PairingQrRenderer {
  render(payload: string): void;
}

export interface BridgeListenerLifecycle {
  start(): Promise<HttpsBridgeListenerAddress>;
  stop(): Promise<void>;
}

export interface AcpSessionLifecycle extends SessionDiscoveryAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  createContinuation?(
    cwd: string,
    context: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): Promise<string>;
  isSessionCreateSupported?(): boolean;
  listModelCatalog?(forceRefresh?: boolean): Promise<AcpModelCatalog>;
  createSession?(
    cwd: string,
    modelId: string | null,
    text: string,
    autoApprove?: boolean,
  ): Promise<string>;
}

export interface SessionHistoryLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  isSessionLoadSupported(): boolean;
  loadSession(sessionId: string): ReturnType<SessionDiscoveryAdapter['loadSession']>;
  getSessionPresentation?(sessionId: string): Promise<DevinSessionPresentation>;
  listCreateOptions?(forceRefresh?: boolean): Promise<DevinCreateOptions>;
  getSessionLiveness?(
    sessionId: string,
  ): Promise<{
    active: boolean;
    kind?: AcpSessionActivity['kind'];
    updatedAt: number;
    pendingQuestion?: AcpTerminalQuestion;
  } | null>;
  getSessionLockPid?(sessionId: string): Promise<number | null>;
}

export interface DesktopBridgeRunnerDependencies {
  platform: 'macos' | 'windows' | 'linux';
  secretStore: SecretStore;
  tlsIdentityGenerator: TlsIdentityGenerator;
  qrRenderer: PairingQrRenderer;
  createListener(options: HttpsBridgeListenerOptions): BridgeListenerLifecycle;
  createAcpClient(executablePath: string): AcpSessionLifecycle;
  createSessionStore?(databasePath: string): SessionHistoryLifecycle;
  onPairingDiagnostic?: HttpsBridgeListenerOptions['onPairingDiagnostic'];
}

export interface StartedDesktopBridge {
  endpoint: string;
  pairingOfferExpiresAt: number;
  sessionDiscoveryEnabled: boolean;
  transportKind: PrivateTransportKind;
}

const unavailableSessions: SessionDiscoveryAdapter = {
  isSessionListSupported: () => false,
  listSessions: () => Promise.reject(new Error('Session discovery is not enabled')),
  isSessionLoadSupported: () => false,
  loadSession: () => Promise.reject(new Error('Session loading is not enabled')),
  isSessionActivitySupported: () => false,
  getSessionActivity: () => Promise.resolve(null),
  isSessionElicitationSupported: () => false,
  getPendingElicitation: () => null,
  respondToElicitation: () => {
    throw new Error('Session questions are not enabled');
  },
  isSessionPermissionSupported: () => false,
  getPendingPermission: () => null,
  respondToPermission: () => {
    throw new Error('Session permissions are not enabled');
  },
  isSessionPromptSupported: () => false,
  promptSession: () => Promise.reject(new Error('Session prompting is not enabled')),
  isSessionCreateSupported: () => false,
  listCreateOptions: () => Promise.reject(new Error('Session creation is not enabled')),
  createSession: () => Promise.reject(new Error('Session creation is not enabled')),
};

const MAXIMUM_REHYDRATION_PAGES = 100;
const MAXIMUM_CREATE_WORKSPACES = 100;
// Reserve one KiB for the omission marker and framing before ACP's 160 KiB limit.
const MAXIMUM_CONTINUATION_CONTEXT_BYTES = 149 * 1024;

function awaitingFromLabel(label: string | undefined): 'answer' | 'approval' | undefined {
  if (label === 'Waiting for your answer') return 'answer';
  if (label === 'Waiting for your approval') return 'approval';
  return undefined;
}

function continuationContext(messages: AcpHistoryMessage[], truncated: boolean): string {
  const blocks: string[] = [];
  let omitted = truncated;
  const base = [
    '# Prior Devin conversation',
    '',
    'This is a read-only transcript supplied to continue the conversation in a new session.',
  ].join('\n');
  let bytes = Buffer.byteLength(base, 'utf8');
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const speaker = message.source === 'user' ? 'User' : 'Devin';
    const block = `## ${speaker}\n\n${message.text}`;
    const blockBytes = Buffer.byteLength(`\n\n${block}`, 'utf8');
    if (bytes + blockBytes > MAXIMUM_CONTINUATION_CONTEXT_BYTES) {
      omitted = true;
      break;
    }
    blocks.unshift(block);
    bytes += blockBytes;
  }
  const omission = omitted ? '\n\nThe oldest transcript content was omitted.' : '';
  return `${base}${omission}\n\n${blocks.join('\n\n')}`;
}

function markLoadedSessionTimeouts(
  loaded: AcpLoadedSession,
  toolCallIds: ReadonlySet<string>,
): AcpLoadedSession {
  if (!loaded.activity || toolCallIds.size === 0) return loaded;
  const marked = { ...loaded };
  Object.defineProperty(marked, 'activity', {
    value: markTimedOutEntries(loaded.activity, toolCallIds),
    enumerable: false,
    writable: true,
    configurable: true,
  });
  if (loaded.messageTimes) {
    Object.defineProperty(marked, 'messageTimes', {
      value: loaded.messageTimes,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return marked;
}

export class RecoverableSessionDiscoveryAdapter implements SessionDiscoveryAdapter {
  private current: SessionDiscoveryAdapter = unavailableSessions;
  private history: SessionHistoryLifecycle | null = null;
  private readonly listedSessionIds = new Set<string>();
  private readonly acpLoadedSessionIds = new Set<string>();

  replace(adapter: SessionDiscoveryAdapter | null): void {
    this.current = adapter ?? unavailableSessions;
    this.listedSessionIds.clear();
    this.acpLoadedSessionIds.clear();
  }

  setHistory(adapter: SessionHistoryLifecycle | null): void {
    this.history = adapter;
  }

  isSessionListSupported(): boolean {
    return this.current.isSessionListSupported();
  }

  async listSessions(input?: unknown): ReturnType<SessionDiscoveryAdapter['listSessions']> {
    const page = await this.current.listSessions(input);
    for (const session of page.sessions) this.listedSessionIds.add(session.sessionId);
    for (const session of page.sessions.slice(0, 200)) {
      try {
        if (this.history?.getSessionPresentation) {
          session.modelId = (await this.history.getSessionPresentation(session.sessionId)).modelId;
        }
      } catch {
        // Model display is optional; never fail session discovery for it.
      }
      try {
        const live = await this.current.getSessionActivity?.(session.sessionId);
        if (live?.active) {
          const awaiting = live.awaiting ?? awaitingFromLabel(live.label);
          session.activity = {
            active: true,
            kind: live.kind,
            updatedAt: live.updatedAt,
            ...(awaiting ? { awaiting } : {}),
          };
        } else if (this.history?.getSessionLiveness) {
          const liveness = await this.history.getSessionLiveness(session.sessionId);
          if (liveness) {
            session.activity = {
              active: liveness.active,
              kind: liveness.kind,
              updatedAt: liveness.updatedAt,
              ...(liveness.pendingQuestion ? { awaiting: 'answer' } : {}),
            };
          }
        }
      } catch {
        // Liveness is best-effort; never fail session discovery for it.
      }
    }
    return page;
  }

  isSessionLoadSupported(): boolean {
    return Boolean(this.history?.isSessionLoadSupported()) || this.current.isSessionLoadSupported();
  }

  isSessionActivitySupported(): boolean {
    return Boolean(
      this.current.isSessionActivitySupported?.() || this.history?.getSessionLiveness,
    );
  }

  async getSessionActivity(input: string): Promise<AcpSessionActivity | null> {
    await this.ensureSessionListed(input);
    const live = (await this.current.getSessionActivity?.(input)) ?? null;
    if (live?.active) {
      const awaiting = live.awaiting ?? awaitingFromLabel(live.label);
      return { ...live, ...(awaiting ? { awaiting } : {}) };
    }
    if (this.history?.getSessionLiveness) {
      try {
        const liveness = await this.history.getSessionLiveness(input);
        if (liveness?.active) {
          const kind = liveness.kind ?? 'thinking';
          return {
            kind,
            label: liveness.pendingQuestion
              ? 'Waiting for your answer in Terminal'
              : defaultActivityLabel(kind),
            active: true,
            updatedAt: liveness.updatedAt,
            ...(liveness.pendingQuestion
              ? { awaiting: 'answer' as const, terminalQuestion: liveness.pendingQuestion }
              : {}),
          };
        }
      } catch {
        // Liveness is best-effort; fall back to the live report.
      }
    }
    return live;
  }

  async getSessionTurn(input: string): Promise<AcpSessionTurn | null> {
    const turn = (await this.current.getSessionTurn?.(input)) ?? null;
    if (!turn) return null;
    const toolCallIds = this.current.getTimedOutToolCallIds?.(input);
    if (!toolCallIds?.size) return turn;
    return { ...turn, activity: markTimedOutEntries(turn.activity, toolCallIds) };
  }

  // Ownership probes (fork patch 6): the lock PID belongs to the history store,
  // the driver PID and live-turn check belong to the ACP client.
  async getSessionLockPid(sessionId: string): Promise<number | null> {
    return (await this.history?.getSessionLockPid?.(sessionId)) ?? null;
  }

  getSessionDriverPid(): number | null {
    return this.current.getSessionDriverPid?.() ?? null;
  }

  isSessionConnectorOwned(sessionId: string): boolean {
    return this.current.isSessionConnectorOwned?.(sessionId) === true;
  }

  isSessionElicitationSupported(): boolean {
    return Boolean(
      this.current.isSessionElicitationSupported?.() &&
      this.current.getPendingElicitation &&
      this.current.respondToElicitation,
    );
  }

  getPendingElicitation(sessionId: string): AcpPendingElicitation | null {
    if (!this.isSessionElicitationSupported() || !this.current.getPendingElicitation) return null;
    return this.current.getPendingElicitation(sessionId);
  }

  respondToElicitation(
    sessionId: string,
    interactionId: string,
    response: AcpElicitationResponse,
  ): void {
    if (!this.isSessionElicitationSupported() || !this.current.respondToElicitation) {
      throw new Error('Session questions are not enabled');
    }
    this.current.respondToElicitation(sessionId, interactionId, response);
  }

  isSessionPermissionSupported(): boolean {
    return Boolean(
      this.current.isSessionPermissionSupported?.() &&
      this.current.getPendingPermission &&
      this.current.respondToPermission,
    );
  }

  getPendingPermission(sessionId: string): AcpPendingPermission | null {
    if (!this.isSessionPermissionSupported() || !this.current.getPendingPermission) return null;
    return this.current.getPendingPermission(sessionId);
  }

  respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: AcpPendingPermission['decisions'][number],
  ): void {
    if (!this.isSessionPermissionSupported() || !this.current.respondToPermission) {
      throw new Error('Session permissions are not enabled');
    }
    this.current.respondToPermission(sessionId, permissionId, decision);
  }

  async loadSession(input: string): ReturnType<SessionDiscoveryAdapter['loadSession']> {
    await this.ensureSessionListed(input);
    if (this.history?.isSessionLoadSupported()) {
      try {
        const loaded = await this.history.loadSession(input);
        const toolCallIds = this.current.getTimedOutToolCallIds?.(input);
        return toolCallIds?.size ? markLoadedSessionTimeouts(loaded, toolCallIds) : loaded;
      } catch {
        // Fall back to negotiated ACP loading when the reviewed store cannot
        // provide this specific session without exposing its private error.
      }
    }
    const snapshot = this.current.getActiveTurnSnapshot?.(input);
    if (snapshot) {
      const toolCallIds = this.current.getTimedOutToolCallIds?.(input);
      return toolCallIds?.size ? markLoadedSessionTimeouts(snapshot, toolCallIds) : snapshot;
    }
    const loaded = await this.current.loadSession(input);
    this.acpLoadedSessionIds.add(input);
    await this.current.releaseSessionOwnership?.(input);
    this.acpLoadedSessionIds.delete(input);
    const toolCallIds = this.current.getTimedOutToolCallIds?.(input);
    return toolCallIds?.size ? markLoadedSessionTimeouts(loaded, toolCallIds) : loaded;
  }

  isSessionPromptSupported(): boolean {
    return this.current.isSessionPromptSupported();
  }

  isSessionCancelSupported(): boolean {
    return Boolean(
      this.current.isSessionCancelSupported?.() && this.current.cancelSession,
    );
  }

  cancelSession(sessionId: string): void | Promise<void> {
    if (!this.isSessionCancelSupported() || !this.current.cancelSession) {
      throw new Error('Session cancellation is not enabled');
    }
    return this.current.cancelSession(sessionId);
  }

  isSessionAutoApproveSupported(): boolean {
    return this.current.isSessionAutoApproveSupported?.() === true;
  }

  isSessionCreateSupported(): boolean {
    const canDiscoverWorkspaces = Boolean(
      this.history?.listCreateOptions || this.current.isSessionListSupported(),
    );
    return Boolean(
      this.current.isSessionCreateSupported?.() &&
      this.current.createSession &&
      canDiscoverWorkspaces,
    );
  }

  async listCreateOptions(forceRefresh = false): Promise<DevinCreateOptions> {
    if (!this.isSessionCreateSupported()) {
      throw new Error('Session creation is not enabled');
    }
    const historyOptions = this.history?.listCreateOptions
      ? await this.history.listCreateOptions()
      : null;
    const recentModelIds = new Set(historyOptions?.models.map((model) => model.id) ?? []);
    const workspaces = historyOptions?.workspaces ?? (await this.listAcpWorkspaces());
    if (this.current.listModelCatalog) {
      try {
        const catalog = await this.current.listModelCatalog(forceRefresh);
        return {
          workspaces,
          models: catalog.models.map((model) => ({
            ...model,
            recent: recentModelIds.has(model.id),
            recommended: model.id === catalog.defaultModelId,
          })),
          defaultModelId: catalog.defaultModelId,
          catalogSource: 'live',
        };
      } catch {
        // Model discovery is optional. Preserve workspace discovery and the
        // default-model create path when ACP cannot enumerate a live catalog.
      }
    }
    if (!historyOptions) {
      return {
        workspaces,
        models: [],
        defaultModelId: null,
        catalogSource: 'recent',
      };
    }
    return {
      workspaces,
      models: historyOptions.models.map((model) => ({
        ...model,
        recent: true,
        recommended: false,
      })),
      defaultModelId: null,
      catalogSource: 'recent',
    };
  }

  private async listAcpWorkspaces(): Promise<Array<{ path: string }>> {
    if (!this.current.isSessionListSupported()) {
      throw new Error('Workspace discovery is not enabled');
    }
    const paths = new Set<string>();
    let cursor: string | undefined;
    for (let pageCount = 0; pageCount < MAXIMUM_REHYDRATION_PAGES; pageCount += 1) {
      const page = await this.current.listSessions(cursor ? { cursor } : {});
      for (const session of page.sessions) {
        if (isAbsolute(session.cwd) || win32.isAbsolute(session.cwd)) paths.add(session.cwd);
        if (paths.size >= MAXIMUM_CREATE_WORKSPACES) break;
      }
      if (paths.size >= MAXIMUM_CREATE_WORKSPACES || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return [...paths].map((path) => ({ path }));
  }

  async createSession(
    cwd: string,
    modelId: string | null,
    text: string,
    autoApprove?: boolean,
  ): Promise<string> {
    if (!this.isSessionCreateSupported() || !this.current.createSession) {
      throw new Error('Session creation is not enabled');
    }
    const sessionId =
      autoApprove === undefined
        ? await this.current.createSession(cwd, modelId, text)
        : await this.current.createSession(cwd, modelId, text, autoApprove);
    this.listedSessionIds.add(sessionId);
    // ACP releases ownership after the asynchronous prompt settles. Do not
    // cache that process-local load beyond the accepted prompt, or the next
    // steering request will skip the required session/load handshake.
    this.acpLoadedSessionIds.delete(sessionId);
    return sessionId;
  }

  async promptSession(
    sessionId: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): ReturnType<SessionDiscoveryAdapter['promptSession']> {
    await this.ensureSessionListed(sessionId);
    if (!this.acpLoadedSessionIds.has(sessionId)) {
      try {
        await this.current.loadSession(sessionId);
        this.acpLoadedSessionIds.add(sessionId);
      } catch (error) {
        const createContinuation = this.current.createContinuation;
        if (
          !isAcpSessionInUseError(error) ||
          !createContinuation ||
          !this.history?.isSessionLoadSupported()
        ) {
          throw error;
        }
        const history = await this.history.loadSession(sessionId);
        if (history.messages.length === 0) throw new Error('Session continuation has no context');
        const context = continuationContext(history.messages, history.truncated);
        const continuedSessionId =
          autoApprove !== undefined
            ? await createContinuation.call(
                this.current,
                history.cwd,
                context,
                text,
                modelId,
                autoApprove,
              )
            : modelId
              ? await createContinuation.call(this.current, history.cwd, context, text, modelId)
              : await createContinuation.call(this.current, history.cwd, context, text);
        this.listedSessionIds.add(continuedSessionId);
        this.acpLoadedSessionIds.delete(continuedSessionId);
        return { continuedSessionId };
      }
    }
    try {
      return autoApprove !== undefined
        ? await this.current.promptSession(sessionId, text, modelId, autoApprove)
        : modelId
          ? await this.current.promptSession(sessionId, text, modelId)
          : await this.current.promptSession(sessionId, text);
    } finally {
      // AcpSessionClient releases the lock when this accepted prompt finishes.
      // Force a fresh load before every later prompt instead of retaining a
      // stale cross-process ownership marker.
      this.acpLoadedSessionIds.delete(sessionId);
    }
  }

  private async ensureSessionListed(sessionId: string): Promise<void> {
    if (this.listedSessionIds.has(sessionId)) return;
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAXIMUM_REHYDRATION_PAGES; pageIndex += 1) {
      const page = await this.listSessions(cursor ? { cursor } : {});
      if (this.listedSessionIds.has(sessionId)) return;
      cursor = page.nextCursor;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    throw new Error('Session is not available in the current ACP process');
  }
}

export function createProductionRunnerDependencies(
  qrRenderer: PairingQrRenderer,
  platform: DesktopBridgeRunnerDependencies['platform'] = process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux',
): DesktopBridgeRunnerDependencies {
  return {
    platform,
    secretStore:
      platform === 'windows' ? new WindowsDpapiSecretStore() : new MacOSKeychainSecretStore(),
    tlsIdentityGenerator:
      platform === 'windows'
        ? new WindowsTlsIdentityGenerator()
        : new OpenSslTlsIdentityGenerator(),
    qrRenderer,
    createListener: (options) => new HttpsBridgeListener(options),
    createAcpClient: (executablePath) => new AcpSessionClient({ executablePath }),
    createSessionStore: (databasePath) => new DevinSessionStore({ databasePath }),
  };
}

export class DesktopBridgeRunner {
  private listener: BridgeListenerLifecycle | null = null;
  private acp: AcpSessionLifecycle | null = null;
  private history: SessionHistoryLifecycle | null = null;
  private readonly sessions = new RecoverableSessionDiscoveryAdapter();
  private acpRecovery: Promise<boolean> | null = null;
  private devinCliPath: string | null = null;
  private pairing: PairingManager | null = null;
  private sessionHandles: SessionHandleRegistry | null = null;
  private workspaceHandles: WorkspaceHandleRegistry | null = null;
  private devices: PersistentDeviceRegistry | null = null;
  private transport: {
    transportSecurity: 'tailscale_wireguard' | 'pinned_tls';
    bridgeEndpoint: string;
    tlsCertificateFingerprint: string;
  } | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly optionsInput: DesktopBridgeRunnerOptions,
    private readonly dependencies: DesktopBridgeRunnerDependencies,
  ) {}

  async start(): Promise<StartedDesktopBridge> {
    if (this.started || this.stopped) throw new Error('Desktop Bridge runner cannot restart');
    const options = runnerOptionsSchema.parse(this.optionsInput);
    this.started = true;

    try {
      const repository = new DesktopBridgeStateRepository(this.dependencies.secretStore);
      const runtime = await loadDesktopBridgeRuntime(repository);
      let sessionHandles: SessionHandleRegistry;
      let tlsIdentity: TlsIdentity;
      try {
        tlsIdentity = await runtime.devices.ensureTlsIdentity(
          this.dependencies.tlsIdentityGenerator,
        );
        sessionHandles = new SessionHandleRegistry(runtime.bridgeId, runtime.sessionHandleKey);
        this.workspaceHandles = new WorkspaceHandleRegistry(
          runtime.bridgeId,
          runtime.sessionHandleKey,
        );
      } finally {
        runtime.sessionHandleKey.fill(0);
      }
      this.sessionHandles = sessionHandles;
      this.devices = runtime.devices;

      let sessions: SessionDiscoveryAdapter = unavailableSessions;
      if (options.devinCliPath) {
        this.devinCliPath = options.devinCliPath;
        // The stable adapter is shared with BridgeService so ACP can recover in
        // place without restarting the listener or invalidating a phone pairing.
        sessions = this.sessions;
        const acp = this.dependencies.createAcpClient(options.devinCliPath);
        try {
          await acp.start();
          this.acp = acp;
          this.sessions.replace(acp);
        } catch {
          await acp.stop().catch(() => {});
          this.acp = null;
          this.sessions.replace(null);
        }
        if (options.devinSessionDbPath && this.dependencies.createSessionStore) {
          const history = this.dependencies.createSessionStore(options.devinSessionDbPath);
          try {
            await history.start();
            this.history = history;
            this.sessions.setHistory(history);
          } catch {
            await history.stop().catch(() => {});
          }
        }
      }

      const pairing = new PairingManager(runtime.identity, runtime.devices, {
        computerName: defaultComputerName(),
      });
      this.pairing = pairing;
      const service = new BridgeService({
        bridgeId: runtime.bridgeId,
        platform: this.dependencies.platform,
        devices: runtime.devices,
        replayGuard: new InMemoryReplayGuard(),
        rateLimiter: new FixedWindowRateLimiter(),
        sessionHandles,
        workspaceHandles: this.workspaceHandles,
        sessions,
      });
      const listener = this.dependencies.createListener({
        service,
        pairing,
        tlsCertificatePem: tlsIdentity.certificatePem,
        tlsPrivateKeyPem: tlsIdentity.privateKeyPem,
        host: options.bindHost ?? options.advertisedHost,
        port: options.bindPort ?? options.port,
        advertisedPort: options.port,
        allowLan: options.bindHost === undefined,
        allowedHosts: [options.advertisedHost],
        transportSecurity:
          privateTransportKind(options.advertisedHost) === 'tailscale_vpn'
            ? 'tailscale_wireguard'
            : 'pinned_tls',
        onPairingDiagnostic: this.dependencies.onPairingDiagnostic,
      });
      this.listener = listener;
      const address = await listener.start();
      if (address.certificateFingerprint !== tlsIdentity.certificateFingerprint) {
        throw new Error('Desktop Bridge listener TLS identity changed unexpectedly');
      }
      const endpointHost =
        isIP(options.advertisedHost) === 6 ? `[${options.advertisedHost}]` : options.advertisedHost;
      const transportSecurity =
        privateTransportKind(options.advertisedHost) === 'tailscale_vpn'
          ? 'tailscale_wireguard'
          : 'pinned_tls';
      const endpoint = `${transportSecurity === 'tailscale_wireguard' ? 'http' : 'https'}://${endpointHost}:${options.port}/`;
      this.transport = {
        transportSecurity,
        bridgeEndpoint: endpoint,
        tlsCertificateFingerprint: address.certificateFingerprint,
      };
      const pairingOfferExpiresAt = this.showPairingOffer();
      return {
        endpoint,
        pairingOfferExpiresAt,
        sessionDiscoveryEnabled: sessions.isSessionListSupported(),
        transportKind: privateTransportKind(options.advertisedHost),
      };
    } catch (error) {
      await this.stopAfterFailure();
      throw error;
    }
  }

  showPairingOffer(now = Date.now()): number {
    if (!this.pairing || !this.transport || this.stopped) {
      throw new Error('Desktop Bridge runner is not active');
    }
    const offer = this.pairing.createOffer(this.transport, now);
    // Do not retain or log this one-time payload; JavaScript strings cannot be reliably zeroed.
    this.dependencies.qrRenderer.render(JSON.stringify(offer));
    return offer.expiresAt;
  }

  pendingReviews(now = Date.now()): PendingPairingReview[] {
    if (!this.pairing || this.stopped) return [];
    return this.pairing.pendingReviews(now);
  }

  async approve(
    pairingId: string,
    options: PairingApprovalOptions = {},
    now = Date.now(),
  ): Promise<boolean> {
    if (!this.pairing || this.stopped) return false;
    return (await this.pairing.approve(pairingId, now, options)).ok;
  }

  deny(pairingId: string): boolean {
    if (!this.pairing || this.stopped) return false;
    return this.pairing.deny(pairingId);
  }

  pairedDevices(): DeviceSummary[] {
    return this.devices?.list() ?? [];
  }

  async updateDevicePermissions(
    deviceId: string,
    options: {
      allowSessionContent: boolean;
      allowSessionPrompt: boolean;
      allowSessionCreate: boolean;
    },
  ): Promise<boolean> {
    const devices = this.devices;
    if (!devices || this.stopped) return false;
    const current = devices.get(deviceId) as DeviceSummary | undefined;
    if (!current || current.status !== 'active') return false;
    return devices.updatePermissions(deviceId, {
      permissions: [
        'bridge:health',
        'session:metadata:read',
        ...(options.allowSessionContent ? (['session:content:read'] as const) : []),
        ...(options.allowSessionPrompt ? (['session:prompt:send'] as const) : []),
        ...(options.allowSessionCreate ? (['session:create'] as const) : []),
      ],
    });
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    if (!this.devices || this.stopped) return false;
    return this.devices.revoke(deviceId);
  }

  async recoverSessionDiscovery(): Promise<boolean> {
    const executablePath = this.devinCliPath;
    if (!executablePath || this.stopped || !this.started) return false;
    const current = this.acp;
    if (
      current &&
      (current.isSessionListSupported() ||
        current.isSessionLoadSupported() ||
        current.isSessionPromptSupported())
    ) {
      return current.isSessionListSupported();
    }
    if (this.acpRecovery) return this.acpRecovery;

    const recovery = (async () => {
      this.acp = null;
      this.sessions.replace(null);
      await current?.stop().catch(() => {});
      if (this.stopped) return false;

      const replacement = this.dependencies.createAcpClient(executablePath);
      try {
        await replacement.start();
        if (this.stopped) {
          await replacement.stop().catch(() => {});
          return false;
        }
        this.acp = replacement;
        this.sessions.replace(replacement);
        return replacement.isSessionListSupported();
      } catch {
        await replacement.stop().catch(() => {});
        return false;
      }
    })();
    this.acpRecovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.acpRecovery === recovery) this.acpRecovery = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const recovery = this.acpRecovery;
    if (recovery) await recovery.catch(() => false);
    const listener = this.listener;
    const acp = this.acp;
    const history = this.history;
    const sessionHandles = this.sessionHandles;
    const workspaceHandles = this.workspaceHandles;
    this.listener = null;
    this.acp = null;
    this.history = null;
    this.sessions.replace(null);
    this.sessions.setHistory(null);
    this.devinCliPath = null;
    this.pairing = null;
    this.sessionHandles = null;
    this.workspaceHandles = null;
    this.devices = null;
    this.transport = null;

    const results = await Promise.allSettled([
      listener?.stop() ?? Promise.resolve(),
      acp?.stop() ?? Promise.resolve(),
      history?.stop() ?? Promise.resolve(),
    ]);
    sessionHandles?.destroy();
    workspaceHandles?.destroy();
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Desktop Bridge did not shut down cleanly');
    }
  }

  async resetPersistentState(): Promise<void> {
    await this.stop();
    await this.dependencies.secretStore.delete();
  }

  private async stopAfterFailure(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Preserve the startup error while still attempting every secure cleanup path.
    }
  }
}
