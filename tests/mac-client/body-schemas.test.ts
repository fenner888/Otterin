import { verify as nodeVerify } from 'node:crypto';

import { canonicalJson } from '../../client-core/src/canonicalJson';
import {
  disconnectComputer,
  getComputerBridgePlatform,
  getComputerBridgePresentation,
  openComputerBridge,
} from '../../client-core/src/computerBridge';
import { loadPairedComputers } from '../../client-core/src/pairedComputers';
import {
  bodySchemas,
  signedRequestEnvelopeSchema,
  type BridgeMethod,
  type SignedRequestEnvelope,
} from '../../bridge/src/schemas';
import {
  InMemorySecretStore,
  NodeDeviceCrypto,
  RecordingTransport,
  TEST_BRIDGE_ID,
  registerPorts,
  seedPairedComputer,
} from './helpers';

const SESSION_ID = `local_${'a'.repeat(43)}`;
const INTERACTION_ID = `interaction_${'b'.repeat(43)}`;
const PERMISSION_ID = `permission_${'c'.repeat(43)}`;
const WORKSPACE_ID = `workspace_${'d'.repeat(43)}`;
const LEGACY_BRIDGE_ID = 'bridge_legacy00000';

const HEALTH_BODY = {
  protocolVersion: 2,
  status: 'ready',
  capabilities: { sessionList: true, sessionLoad: true, sessionPrompt: true },
};
const FEATURES_BODY = {
  sessionElicitation: true,
  activityTimeline: true,
  permissionPrompts: true,
  sessionCancel: true,
  autoApprove: true,
};
const CREATE_OPTIONS_BODY = {
  workspaces: [{ id: WORKSPACE_ID, name: 'weather-app' }],
  models: [{ id: 'model-one', name: 'Model One High', recommended: true }],
  defaultModelId: 'model-one',
  catalogSource: 'live',
};

function responseFor(method: string, body: Record<string, unknown>): Record<string, unknown> {
  if (method === 'bridge.health') return HEALTH_BODY;
  if (method === 'bridge.features') {
    return body.presentation === true
      ? {
          messageTimestamps: true,
          grants: { viewSessions: true, sendPrompts: true, startSessions: true },
        }
      : FEATURES_BODY;
  }
  if (method === 'bridge.platform') return { platform: 'macos' };
  if (method === 'bridge.version') return { version: '1.2.3' };
  if (method === 'device.revoke') return { revoked: true };
  if (method === 'session.list') return { sessions: [] };
  if (method === 'session.load') {
    return {
      session: { id: body.sessionId, origin: 'computer', workspaceName: 'weather-app' },
      messages: [],
      truncated: false,
    };
  }
  if (method === 'session.activity') {
    return { active: false, kind: 'responding', label: 'Response ready', updatedAt: 1_800_000_000_000 };
  }
  if (method === 'session.elicitation') return { interaction: null };
  if (method === 'session.elicitation.respond') return { accepted: true };
  if (method === 'session.permission') return { permission: null };
  if (method === 'session.permission.respond') return { accepted: true };
  if (method === 'session.cancel') return { cancelled: true };
  if (method === 'session.prompt') return { accepted: true };
  if (method === 'session.create_options') return CREATE_OPTIONS_BODY;
  if (method === 'session.create') return { accepted: true, sessionId: SESSION_ID };
  throw new Error(`Unscripted method ${method}`);
}

describe('client-core body builders vs bridge bodySchemas', () => {
  let crypto: NodeDeviceCrypto;
  let transport: RecordingTransport;
  let store: InMemorySecretStore;
  const spkiByBridge = new Map<string, string>();

  beforeEach(async () => {
    crypto = new NodeDeviceCrypto();
    transport = new RecordingTransport((_path, body) => {
      const envelope = body as { method?: string; body?: Record<string, unknown> };
      return { status: 200, body: responseFor(envelope.method ?? '', envelope.body ?? {}) };
    });
    store = new InMemorySecretStore();
    registerPorts(crypto, transport, store);
    spkiByBridge.clear();
    const seeded = await seedPairedComputer({ crypto, bridgeId: TEST_BRIDGE_ID });
    spkiByBridge.set(TEST_BRIDGE_ID, seeded.publicKeySpki);
    // A second bridge that never advertises interaction support, so its
    // envelopes exercise the legacy (flag-free) body shapes.
    const legacy = await seedPairedComputer({
      crypto,
      bridgeId: LEGACY_BRIDGE_ID,
      computerName: 'Legacy Mac',
    });
    spkiByBridge.set(LEGACY_BRIDGE_ID, legacy.publicKeySpki);
  });

  function postedEnvelope(index: number): SignedRequestEnvelope {
    const envelope = transport.envelopes()[index];
    expect(envelope).toBeDefined();
    return signedRequestEnvelopeSchema.parse(envelope);
  }

  function expectValidEnvelope(
    envelope: SignedRequestEnvelope,
    method: BridgeMethod,
    expectedBody: unknown,
  ): void {
    const parsed = signedRequestEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.method).toBe(method);
    expect(bodySchemas[method].safeParse(envelope.body).success).toBe(true);
    expect(envelope.body).toEqual(expectedBody);
    expect(envelope.expiresAt - envelope.issuedAt).toBe(15_000);
    const { signature, ...unsigned } = envelope;
    const publicKeySpki = spkiByBridge.get(envelope.bridgeId);
    expect(publicKeySpki).toBeDefined();
    expect(
      nodeVerify(
        null,
        Buffer.from(canonicalJson(unsigned), 'utf8'),
        { key: Buffer.from(publicKeySpki!, 'base64url'), format: 'der', type: 'spki' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  }

  it('builds valid bodies for every bridge method', async () => {
    const connection = await openComputerBridge(TEST_BRIDGE_ID);

    // Prime the interaction gate, then every subsequent interaction-capable
    // call carries interaction:true — matching bridge.features advertisement.
    await connection.getFeatures();
    expectValidEnvelope(postedEnvelope(0), 'bridge.features', { interaction: true });

    await connection.getHealth();
    expectValidEnvelope(postedEnvelope(1), 'bridge.health', {});

    await connection.getVersion();
    expectValidEnvelope(postedEnvelope(2), 'bridge.version', {});

    await getComputerBridgePlatform(TEST_BRIDGE_ID);
    expectValidEnvelope(postedEnvelope(3), 'bridge.platform', {});

    await getComputerBridgePresentation(TEST_BRIDGE_ID);
    expectValidEnvelope(postedEnvelope(4), 'bridge.features', { presentation: true });

    await connection.listSessions({});
    expectValidEnvelope(postedEnvelope(5), 'session.list', { interaction: true });

    await connection.listSessions({ cursor: 'cursor-2' });
    expectValidEnvelope(postedEnvelope(6), 'session.list', {
      cursor: 'cursor-2',
      interaction: true,
    });

    await connection.loadSession(SESSION_ID);
    expectValidEnvelope(postedEnvelope(7), 'session.load', {
      sessionId: SESSION_ID,
      interaction: true,
    });

    await connection.loadSession(SESSION_ID, { timestamps: true });
    expectValidEnvelope(postedEnvelope(8), 'session.load', {
      sessionId: SESSION_ID,
      interaction: true,
      timestamps: true,
    });

    await connection.getSessionActivity(SESSION_ID);
    expectValidEnvelope(postedEnvelope(9), 'session.activity', {
      sessionId: SESSION_ID,
      interaction: true,
    });

    await connection.getSessionElicitation(SESSION_ID);
    expectValidEnvelope(postedEnvelope(10), 'session.elicitation', { sessionId: SESSION_ID });

    await connection.respondToSessionElicitation({
      sessionId: SESSION_ID,
      interactionId: INTERACTION_ID,
      action: 'accept',
      content: { field: 'value', count: 2, ok: true, tags: ['a', 'b'] },
    });
    expectValidEnvelope(postedEnvelope(11), 'session.elicitation.respond', {
      sessionId: SESSION_ID,
      interactionId: INTERACTION_ID,
      action: 'accept',
      content: { field: 'value', count: 2, ok: true, tags: ['a', 'b'] },
    });

    await connection.respondToSessionElicitation({
      sessionId: SESSION_ID,
      interactionId: INTERACTION_ID,
      action: 'decline',
    });
    expectValidEnvelope(postedEnvelope(12), 'session.elicitation.respond', {
      sessionId: SESSION_ID,
      interactionId: INTERACTION_ID,
      action: 'decline',
    });

    await connection.getSessionPermission(SESSION_ID);
    expectValidEnvelope(postedEnvelope(13), 'session.permission', { sessionId: SESSION_ID });

    await connection.respondToSessionPermission({
      sessionId: SESSION_ID,
      permissionId: PERMISSION_ID,
      decision: 'allow_once',
    });
    expectValidEnvelope(postedEnvelope(14), 'session.permission.respond', {
      sessionId: SESSION_ID,
      permissionId: PERMISSION_ID,
      decision: 'allow_once',
    });

    await connection.cancelSession(SESSION_ID);
    expectValidEnvelope(postedEnvelope(15), 'session.cancel', { sessionId: SESSION_ID });

    await connection.promptSession(SESSION_ID, 'Fix the flaky test', 'model-one', true);
    expectValidEnvelope(postedEnvelope(16), 'session.prompt', {
      sessionId: SESSION_ID,
      text: 'Fix the flaky test',
      modelId: 'model-one',
      autoApprove: true,
    });

    await connection.getCreateOptions();
    expectValidEnvelope(postedEnvelope(17), 'session.create_options', {});

    await connection.getCreateOptions(true);
    expectValidEnvelope(postedEnvelope(18), 'session.create_options', { refresh: true });

    await connection.createSession({
      workspaceId: WORKSPACE_ID,
      modelId: 'model-one',
      text: 'Start a new session',
      autoApprove: false,
    });
    expectValidEnvelope(postedEnvelope(19), 'session.create', {
      workspaceId: WORKSPACE_ID,
      modelId: 'model-one',
      text: 'Start a new session',
      autoApprove: false,
    });
  });

  it('omits the interaction flag when the bridge never advertised support', async () => {
    const connection = await openComputerBridge(LEGACY_BRIDGE_ID);
    await connection.listSessions({});
    const envelope = postedEnvelope(0);
    expectValidEnvelope(envelope, 'session.list', {});
    expect('interaction' in (envelope.body as Record<string, unknown>)).toBe(false);

    await connection.loadSession(SESSION_ID);
    expectValidEnvelope(postedEnvelope(1), 'session.load', { sessionId: SESSION_ID });
  });

  it('builds a device.revoke body and removes the credential locally', async () => {
    await disconnectComputer(TEST_BRIDGE_ID);
    expectValidEnvelope(postedEnvelope(0), 'device.revoke', {});

    const remaining = await loadPairedComputers();
    expect(remaining.map((computer) => computer.bridgeId)).toEqual([LEGACY_BRIDGE_ID]);
  });
});
