import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import type { AcpLoadedSession, AcpSessionPage } from '../../bridge/src/acp';
import { FixedWindowRateLimiter } from '../../bridge/src/rate-limit';
import { InMemoryReplayGuard } from '../../bridge/src/replay';
import { BridgeService, type SessionDiscoveryAdapter } from '../../bridge/src/service';
import { signingPayload, type DeviceStore } from '../../bridge/src/security';
import { SessionHandleRegistry } from '../../bridge/src/session-handles';
import { WorkspaceHandleRegistry } from '../../bridge/src/workspace-handles';
import {
  BRIDGE_PROTOCOL_VERSION,
  sessionListBodySchema,
  sessionLoadBodySchema,
  type BridgeMethod,
  type DeviceRecord,
  type SignedRequestEnvelope,
} from '../../bridge/src/schemas';

const NOW = 1_800_000_000_000;
const BRIDGE_ID = 'bridge_1234567890';
const DEVICE_ID = 'device_1234567890';
const RAW_SESSION_ID = 'raw-private-session-id';

class OwnershipFakeSessionAdapter implements SessionDiscoveryAdapter {
  page: AcpSessionPage = {
    sessions: [
      {
        sessionId: RAW_SESSION_ID,
        cwd: '/Users/frank/Secret Project',
        title: 'Secret title',
        updatedAt: '2026-07-10T12:00:00Z',
      },
    ],
  };
  loaded: AcpLoadedSession = {
    sessionId: RAW_SESSION_ID,
    cwd: '/Users/frank/Secret Project',
    messages: [
      { source: 'user', text: 'Please review this.' },
      { source: 'devin', text: 'The review is complete.' },
    ],
    truncated: false,
  };
  lockPid: number | null = null;
  driverPid: number | null = null;
  connectorOwned = false;

  isSessionListSupported(): boolean {
    return true;
  }

  async listSessions(): Promise<AcpSessionPage> {
    return this.page;
  }

  isSessionLoadSupported(): boolean {
    return true;
  }

  async loadSession(): Promise<AcpLoadedSession> {
    return this.loaded;
  }

  isSessionPromptSupported(): boolean {
    return true;
  }

  async promptSession(): Promise<void> {}

  async getSessionLockPid(): Promise<number | null> {
    return this.lockPid;
  }

  getSessionDriverPid(): number | null {
    return this.driverPid;
  }

  isSessionConnectorOwned(): boolean {
    return this.connectorOwned;
  }
}

class ProbelessFakeSessionAdapter implements SessionDiscoveryAdapter {
  isSessionListSupported(): boolean {
    return true;
  }

  async listSessions(): Promise<AcpSessionPage> {
    return {
      sessions: [
        {
          sessionId: RAW_SESSION_ID,
          cwd: '/Users/frank/Secret Project',
          updatedAt: '2026-07-10T12:00:00Z',
        },
      ],
    };
  }

  isSessionLoadSupported(): boolean {
    return true;
  }

  async loadSession(): Promise<AcpLoadedSession> {
    return {
      sessionId: RAW_SESSION_ID,
      cwd: '/Users/frank/Secret Project',
      messages: [{ source: 'user', text: 'Hi.' }],
      truncated: false,
    };
  }

  isSessionPromptSupported(): boolean {
    return true;
  }

  async promptSession(): Promise<void> {}
}

describe('opt-in session ownership', () => {
  const deviceKeys = generateKeyPairSync('ed25519');
  let device: DeviceRecord;
  let devices: DeviceStore;
  let adapter: OwnershipFakeSessionAdapter;

  beforeEach(() => {
    device = {
      bridgeId: BRIDGE_ID,
      deviceId: DEVICE_ID,
      deviceName: 'Otterin (Mac)',
      publicKeySpki: deviceKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      status: 'active',
      pairedAt: NOW - 60_000,
      permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
    };
    devices = { get: (deviceId) => (deviceId === DEVICE_ID ? device : undefined) };
    adapter = new OwnershipFakeSessionAdapter();
  });

  function envelope(method: BridgeMethod, body: unknown): SignedRequestEnvelope {
    const unsigned: Omit<SignedRequestEnvelope, 'signature'> = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: BRIDGE_ID,
      deviceId: DEVICE_ID,
      requestId: randomUUID(),
      issuedAt: NOW - 100,
      expiresAt: NOW + 10_000,
      nonce: randomBytes(24).toString('base64url'),
      method,
      body,
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(signingPayload(unsigned), 'utf8'),
        deviceKeys.privateKey,
      ).toString('base64url'),
    };
  }

  function service(
    overrides: Partial<ConstructorParameters<typeof BridgeService>[0]> = {},
  ): BridgeService {
    return new BridgeService({
      bridgeId: BRIDGE_ID,
      platform: 'macos',
      devices,
      replayGuard: new InMemoryReplayGuard(),
      rateLimiter: new FixedWindowRateLimiter(),
      sessionHandles: new SessionHandleRegistry(BRIDGE_ID, randomBytes(32)),
      workspaceHandles: new WorkspaceHandleRegistry(BRIDGE_ID, randomBytes(32)),
      sessions: adapter,
      ...overrides,
    });
  }

  const context = () => ({ peerKey: 'loopback-peer', now: NOW });

  function listedSession(
    body: unknown,
    svc: BridgeService = service(),
  ): Promise<Record<string, unknown>> {
    return svc
      .handle(envelope('session.list', body), context())
      .then((result) => {
        expect(result.status).toBe(200);
        const sessions = (result.body as { sessions: Array<Record<string, unknown>> }).sessions;
        return sessions[0] ?? {};
      });
  }

  it('accepts the ownership flag on strict list and load body schemas', () => {
    expect(sessionListBodySchema.parse({ ownership: true })).toEqual({ ownership: true });
    expect(
      sessionLoadBodySchema.parse({ sessionId: 'x', ownership: false }),
    ).toEqual({ sessionId: 'x', ownership: false });
    // The strict schemas still reject unrelated fields.
    expect(
      sessionListBodySchema.safeParse({ ownership: true, tenant: 'x' }).success,
    ).toBe(false);
  });

  it('omits owner fields when the request does not opt in', async () => {
    adapter.lockPid = 424_242;
    adapter.connectorOwned = false;
    const svc = service();
    const session = await listedSession({}, svc);
    expect(session).not.toHaveProperty('owner');
    expect(session).not.toHaveProperty('ownerName');

    const result = await svc.handle(
      envelope('session.load', { sessionId: session.id }),
      context(),
    );
    expect(result.status).toBe(200);
    const loaded = (result.body as { session: Record<string, unknown> }).session;
    expect(loaded).not.toHaveProperty('owner');
    expect(loaded).not.toHaveProperty('ownerName');
  });

  it('reports free when no live lock exists', async () => {
    adapter.lockPid = null;
    const session = await listedSession({ ownership: true });
    expect(session.owner).toBe('free');
    expect(session).not.toHaveProperty('ownerName');
  });

  it('reports locked_external with ownerName for a foreign live lock', async () => {
    adapter.lockPid = 424_242;
    adapter.driverPid = 777;
    const resolve = jest.fn(async (pid: number) => (pid === 424_242 ? 'Devin' : undefined));
    const session = await service({ processNameResolver: resolve })
      .handle(envelope('session.list', { ownership: true }), context())
      .then((result) => {
        expect(result.status).toBe(200);
        return (result.body as { sessions: Array<Record<string, unknown>> }).sessions[0] ?? {};
      });
    expect(session.owner).toBe('locked_external');
    expect(session.ownerName).toBe('Devin');
    expect(resolve).toHaveBeenCalledWith(424_242);
  });

  it('omits ownerName when the process name cannot be resolved', async () => {
    adapter.lockPid = 424_242;
    adapter.driverPid = 777;
    const session = await service({ processNameResolver: async () => undefined })
      .handle(envelope('session.list', { ownership: true }), context())
      .then((result) => {
        expect(result.status).toBe(200);
        return (result.body as { sessions: Array<Record<string, unknown>> }).sessions[0] ?? {};
      });
    expect(session.owner).toBe('locked_external');
    expect(session).not.toHaveProperty('ownerName');
  });

  it('reports connector_live when the lock PID matches the bridge ACP child', async () => {
    adapter.lockPid = 424_242;
    adapter.driverPid = 424_242;
    const session = await listedSession({ ownership: true });
    expect(session.owner).toBe('connector_live');
    expect(session).not.toHaveProperty('ownerName');
  });

  it('reports connector_live for a live bridge-owned turn even without lock data', async () => {
    adapter.connectorOwned = true;
    adapter.lockPid = null;
    const session = await listedSession({ ownership: true });
    expect(session.owner).toBe('connector_live');
  });

  it('emits owner on the loaded session only when requested', async () => {
    adapter.lockPid = 424_242;
    adapter.driverPid = 777;
    const svc = service({ processNameResolver: async () => 'Devin' });
    const session = await listedSession({}, svc);
    const result = await svc.handle(
      envelope('session.load', { sessionId: session.id, ownership: true }),
      context(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      session: { owner: 'locked_external', ownerName: 'Devin' },
    });
  });

  it('omits owner entirely when the adapter cannot probe ownership', async () => {
    const probeless = new ProbelessFakeSessionAdapter();
    const result = await service({ sessions: probeless }).handle(
      envelope('session.list', { ownership: true }),
      context(),
    );
    expect(result.status).toBe(200);
    const session = (result.body as { sessions: Array<Record<string, unknown>> }).sessions[0] ?? {};
    // An adapter without probes must not guess "free" for a session it cannot
    // see; the field is simply absent.
    expect(session).not.toHaveProperty('owner');
    expect(session).not.toHaveProperty('ownerName');
  });
});
