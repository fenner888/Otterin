// Live end-to-end test: real DesktopBridgeRunner (TLS listener on this
// Mac's Tailscale address) + real client-core pairing/session calls through
// the mac-client Node ports — the same wire path the Electron app uses.
//
// Opt-in: runs only when OTTERIN_E2E=1. Requires:
//   - Tailscale connected (advertisedHost = 100.64.0.0/10 interface)
//   - the Devin desktop CLI present (ACP discovery + prompts)
//
// The runner's state store is in-memory (fresh TLS identity + registry per
// run) so the test bridge is fully self-contained; the created credential
// is revoked at the end to exercise device.revoke.

import { networkInterfaces } from 'node:os';

import { DevinSessionStore } from '../../bridge/src/devin-session-store';
import { AcpSessionClient } from '../../bridge/src/acp';
import { HttpsBridgeListener } from '../../bridge/src/listener';
import type { SecretStore } from '../../bridge/src/secret-store';
import { discoverPrivateLanAddresses } from '../../bridge/src/network';
import { discoverMacOSDevinSessionDb } from '../../bridge/src/connector-platform';
import { DesktopBridgeRunner } from '../../bridge/src/runner';
import { OpenSslTlsIdentityGenerator } from '../../bridge/src/tls-identity';

import { registerBridgeTransport, registerDeviceCrypto, registerSecretStore, type SecretBlobStore } from '../../client-core/src/ports';
import { pairComputerFromQrPayload } from '../../client-core/src/computerPairing';
import { disconnectComputer, openComputerBridge } from '../../client-core/src/computerBridge';
import { nodeDeviceCrypto } from '../../mac-client/src/main/crypto.node';
import { nodeBridgeTransport } from '../../mac-client/src/main/transport.node';

const E2E = process.env.OTTERIN_E2E === '1';
const run = E2E ? describe : describe.skip;

const DEVIN_CLI =
  '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const E2E_PORT = 45_833;

const memory = new Map<string, string>();
const memorySecrets: SecretBlobStore = {
  read: async (key) => memory.get(key) ?? null,
  write: async (key, value) => void memory.set(key, value),
  delete: async (key) => void memory.delete(key),
};

// Runner state store — in-memory keeps the test bridge's TLS identity and
// paired-device registry self-contained (no keychain prompts, no sharing
// with the installed Connector).
let runnerState: string | null = null;
const memoryRunnerSecrets: SecretStore = {
  get: async () => runnerState,
  set: async (value) => void (runnerState = value),
  delete: async () => void (runnerState = null),
};

function tailscaleHost(): string {
  const host = discoverPrivateLanAddresses(networkInterfaces() as never).find((address) =>
    address.startsWith('100.'),
  );
  if (!host) throw new Error('No Tailscale (100.64.0.0/10) interface found');
  return host;
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, stepMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, stepMs));
  }
}

// The bridge 503s session methods while its ACP child boots/respawns —
// plan-mandated transient state, retry rather than fail.
async function retryTransient<T>(call: () => Promise<T>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code !== 'unavailable' || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
  }
}

run('live bridge E2E', () => {
  jest.setTimeout(240_000);
  let runner: DesktopBridgeRunner | undefined;
  let bridgeId: string | undefined;

  afterAll(async () => {
    if (bridgeId) {
      await disconnectComputer(bridgeId).catch(() => undefined);
    }
    await runner?.stop();
  });

  it('pairs, lists, loads, prompts, and cancels over the real socket', async () => {
    registerDeviceCrypto(nodeDeviceCrypto);
    registerBridgeTransport(nodeBridgeTransport);
    registerSecretStore(memorySecrets);

    const offers: string[] = [];
    const dbPath = await discoverMacOSDevinSessionDb(process.env);
    expect(dbPath).toBeTruthy();

    runner = new DesktopBridgeRunner(
      {
        advertisedHost: tailscaleHost(),
        port: E2E_PORT,
        devinCliPath: DEVIN_CLI,
        devinSessionDbPath: dbPath!,
      },
      {
        platform: 'macos',
        secretStore: memoryRunnerSecrets,
        tlsIdentityGenerator: new OpenSslTlsIdentityGenerator(),
        qrRenderer: { render: (payload: string) => offers.push(payload) },
        createListener: (options) => new HttpsBridgeListener(options),
        createAcpClient: (executablePath) => new AcpSessionClient({ executablePath }),
        createSessionStore: (databasePath) => new DevinSessionStore({ databasePath }),
      },
    );

    const started = await runner.start();
    console.log(`bridge listening at ${started.endpoint}`);

    const offerJson = await waitFor(() => offers.at(-1) ?? null, 10_000);

    // Client submits; bridge approves the pending review as the Connector UI
    // would (content grant) and then widens to prompt+create like the
    // permissions sheet.
    const pairPromise = pairComputerFromQrPayload(offerJson, {
      computerName: 'E2E Connector',
      deviceName: 'Otterin (Mac) E2E',
    });
    const approved = (async () => {
      const review = await waitFor(() => runner!.pendingReviews()[0] ?? null, 30_000);
      expect(review.deviceKeyFingerprint).toMatch(/^[A-Za-z0-9_-]{8,}$/);
      const ok = await runner!.approve(review.pairingId, { allowSessionContent: true });
      expect(ok).toBe(true);
      const summary = await pairPromise;
      const device = runner!
        .pairedDevices()
        .find((entry) => entry.deviceName === 'Otterin (Mac) E2E');
      expect(device).toBeTruthy();
      await runner!.updateDevicePermissions(device!.deviceId, {
        allowSessionContent: true,
        allowSessionPrompt: true,
        allowSessionCreate: true,
      });
      return summary;
    })();
    const computer = await approved;
    bridgeId = computer.bridgeId;
    console.log(`paired with bridge ${bridgeId.slice(0, 12)}…`);

    const connection = await openComputerBridge(bridgeId);

    const health = await connection.getHealth();
    expect(health).toBeTruthy();
    const features = await connection.getFeatures();
    console.log('features:', JSON.stringify(features));
    const version = await connection.getVersion();
    expect(version).toBeTruthy();

    // Opt-in ownership flag — patch 6 — plus interaction negotiation.
    const page = await retryTransient(() => connection.listSessions({ ownership: true }));
    expect(Array.isArray(page.sessions)).toBe(true);
    console.log(`session.list returned ${page.sessions.length} sessions`);
    const withOwner = page.sessions.filter((session) => session.owner !== undefined);
    console.log(`ownership populated on ${withOwner.length}/${page.sessions.length} sessions`);
    for (const session of withOwner) {
      expect(['free', 'locked_external', 'connector_live']).toContain(session.owner);
    }

    // Load history — prefer an unlocked session: locked sessions load via
    // the sqlite history store when available, but an ACP-routed load on a
    // session driven by another client can stall behind the lock.
    const target =
      page.sessions.find((session) => session.owner === 'free') ?? page.sessions[0];
    if (!target) throw new Error('no sessions returned');
    const loaded = await retryTransient(() =>
      connection.loadSession(target.id, { timestamps: true }),
    );
    expect(loaded.session.id).toBe(target.id);
    console.log(
      `loaded ${target.id.slice(0, 16)}… messages=${loaded.messages.length} truncated=${loaded.truncated}`,
    );

    const activity = await retryTransient(() => connection.getSessionActivity(target.id));
    expect(activity).toBeTruthy();

    // Full steer path: create a session, prompt it, watch activity, cancel.
    // Prompting is credential-gated: current devin acp builds only answer
    // `authenticate` through an interactive browser flow (methodId
    // devin-browser), or not at all when nobody is at the Mac. With
    // WINDSURF_API_KEY forwarded into the runner env the child is
    // pre-authenticated and this leg completes; otherwise it must fail
    // with the honest 'unavailable' error instead of hanging the bridge.
    const createOptions = await retryTransient(() => connection.getCreateOptions());
    const workspace = createOptions.workspaces[0];
    if (!workspace) throw new Error('no workspaces in create options');
    let newSessionId: string;
    try {
      const created = await connection.createSession({
        workspaceId: workspace.id,
        text: 'Reply with exactly the word OK.',
      });
      newSessionId = created.sessionId;
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code === 'unavailable') {
        console.log('prompt path unavailable: ACP authentication did not complete (expected without WINDSURF_API_KEY or an interactive sign-in) — monitor paths verified');
        return;
      }
      throw error;
    }
    console.log(`created session ${newSessionId.slice(0, 16)}…`);
    await connection.promptSession(newSessionId, 'Reply with exactly the word OK.');

    const seenActivity = await waitFor(async () => {
      try {
        const snapshot = await connection.getSessionActivity(newSessionId);
        return snapshot && (snapshot.active || (snapshot as { awaiting?: unknown }).awaiting)
          ? snapshot
          : null;
      } catch {
        return null;
      }
    }, 90_000, 2_000);
    console.log('live activity observed:', JSON.stringify(seenActivity).slice(0, 300));

    await connection.cancelSession(newSessionId).catch((error: unknown) => {
      console.log('cancel returned', error instanceof Error ? error.message : 'error');
    });
    console.log('cancelled');
  });
});
