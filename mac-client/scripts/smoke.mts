// Plain-Node smoke check for the macOS port adapters (PLAN §10.4
// acceptance pre-flight). Exercises everything that does NOT need the
// electron binary — crypto.node, transport.node, bridge-client helpers,
// scheduler, ipc payload schemas + error mapping, and the jsqr decode
// helpers. Run:
//   npx esbuild scripts/smoke.mts --bundle --platform=node --format=cjs \
//     --external:electron --outfile=/tmp/otterin-smoke.cjs && node /tmp/otterin-smoke.cjs
//
// safeStorage/capture modules are imported for symbols only — their
// electron calls are lazy-required, so importing them is safe here.

import {
  registerBridgeTransport,
  registerSecretStore,
  requireDeviceCrypto,
  type SecretBlobStore,
} from '../../client-core/src/ports';
import { initializeClientCorePorts, requireClientCoreProtocol } from '../src/main/client-core-wiring';
import { bgraToRgba, decodeQrFromRgba } from '../src/main/pairing-capture';
import { nodeBridgeTransport } from '../src/main/transport.node';
import { toPublicError } from '../src/main/ipc';
import { PollScheduler } from '../src/main/scheduler';
import { pendingInteractionsForPage, sessionPageSnapshotSchema } from '../src/main/bridge-client';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory SecretBlobStore for crypto.
const memory = new Map<string, string>();
const memoryStore: SecretBlobStore = {
  read: async (key) => memory.get(key) ?? null,
  write: async (key, value) => void memory.set(key, value),
  delete: async (key) => void memory.delete(key),
};

initializeClientCorePorts();
registerSecretStore(memoryStore); // secrets.mac requires electron — override
registerBridgeTransport(nodeBridgeTransport);

// ---------------------------------------------------------------------------
// crypto.node
{
  const crypto = requireDeviceCrypto();
  const identity = await crypto.createDeviceIdentity();
  check('identity spki 59 chars', identity.publicKeySpki.length === 59);
  check('identity uuid keyId', /^[0-9a-f-]{36}$/.test(identity.keyId));
  check('hasDeviceIdentity', await crypto.hasDeviceIdentity(identity.keyId));

  const signature = await crypto.sign(identity.keyId, 'message');
  check('signature 86 chars', signature.length === 86);
  check(
    'verify ok',
    await crypto.verify(identity.publicKeySpki, 'message', signature),
  );
  check(
    'verify wrong msg',
    !(await crypto.verify(identity.publicKeySpki, 'other', signature)),
  );

  const fingerprint = await crypto.fingerprintPublicKeySpki(identity.publicKeySpki);
  check('fingerprint 43 chars', fingerprint.length === 43);

  const hmac = await crypto.hmacSha256('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'x');
  check('hmac 43 chars', hmac.length === 43);

  const req = await crypto.createRequestIdentity();
  check('nonce 32 chars', req.nonce.length === 32);
  check('requestId uuid', /^[0-9a-f-]{36}$/.test(req.requestId));
  check('pinned unavailable', !crypto.isPinnedBridgeTransportAvailable());

  await crypto.deleteDeviceIdentity(identity.keyId);
  check('deleteDeviceIdentity', !(await crypto.hasDeviceIdentity(identity.keyId)));

  await crypto.createDeviceIdentity();
  await crypto.createDeviceIdentity();
  await crypto.deleteAllDeviceIdentities();
  check('deleteAllDeviceIdentities', memory.size === 0);
}

// ---------------------------------------------------------------------------
// transport.node — endpoint/path/body guards. The live socket path is
// exercised by the client-core integration tests (the endpoint schema
// requires a 100.64/10 origin, which a local listener cannot satisfy).
{
  await nodeBridgeTransport
    .postTailnetBridgeJson('http://127.0.0.1:9999/', '/v1/request', {})
    .then(() => check('endpoint schema rejects loopback', false))
    .catch((error: Error) =>
      check('endpoint schema rejects loopback', 'code' in error && error.code === 'invalid_endpoint'),
    );

  await nodeBridgeTransport
    .postTailnetBridgeJson('http://100.70.1.2:45831/', '/v1/nope', {})
    .then(() => check('path allowlist enforced', false))
    .catch((error: Error) =>
      check('path allowlist enforced', 'code' in error && error.code === 'invalid_endpoint'),
    );

  await nodeBridgeTransport
    .postTailnetBridgeJson('http://100.70.1.2:45831/', '/v1/request', new Array(70_000).fill('x'))
    .then(() => check('non-object body rejected', false))
    .catch((error: Error) =>
      check('non-object body rejected', 'code' in error && error.code === 'invalid_response'),
    );

  await nodeBridgeTransport
    .postPinnedBridgeJson('https://example.invalid:443/', '/v1/request', 'x'.repeat(43), {})
    .then(() => check('pinned transport refuses', false))
    .catch((error: Error) =>
      check('pinned transport refuses', 'code' in error && error.code === 'unsupported_transport'),
    );
}

// ---------------------------------------------------------------------------
// bridge-client extraction helpers
{
  const page = sessionPageSnapshotSchema.parse({
    sessions: [
      { id: 'local_a', activity: { active: true, awaiting: 'approval', turn: {} } },
      { id: 'local_b', activity: { active: false } },
      { id: 'local_c' },
    ],
    nextCursor: 'c1',
  });
  const pending = pendingInteractionsForPage('bridge_x', page);
  check('pending extraction', pending.length === 1 && pending[0]?.kind === 'approval');
}

// ---------------------------------------------------------------------------
// ipc error mapping
{
  const mapped = toPublicError(new Error('raw internal detail'));
  check('raw error sanitized', mapped.code === 'internal_error' && mapped.message !== 'raw internal detail');
}

// ---------------------------------------------------------------------------
// pairing capture helpers (pure parts)
{
  const bgra = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
  const rgba = bgraToRgba(bgra);
  check(
    'bgra->rgba swap',
    rgba[0] === 30 && rgba[1] === 20 && rgba[2] === 10 && rgba[3] === 255 &&
      rgba[4] === 60 && rgba[5] === 50 && rgba[6] === 40 && rgba[7] === 255,
  );
  check('decode wrong-length rejected', decodeQrFromRgba(new Uint8ClampedArray(8), 10, 10) === null);
  check('decode empty rejected', decodeQrFromRgba(new Uint8ClampedArray(0), 0, 0) === null);
}

// ---------------------------------------------------------------------------
// scheduler — manual clock, scripted connection
{
  const timers = new Map<number, { fn: () => void; id: number }>();
  let timerId = 0;
  const clock = { value: 0 };
  const fakeSetTimeout = ((fn: () => void, ms?: number) => {
    const id = ++timerId;
    timers.set(id, { fn, id });
    void ms;
    return id as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const tick = () => {
    const pending = [...timers.values()];
    timers.clear();
    clock.value += 1;
    for (const { fn } of pending) fn();
  };

  const calls: string[] = [];
  const scheduler = new PollScheduler({
    resolveConnection: async (bridgeId) => {
      calls.push(`resolve:${bridgeId}`);
      return {
        bridgeId,
        getHealth: async () => ({}),
        getFeatures: async () => ({}),
        getVersion: async () => ({}),
        getPlatform: async () => ({}),
        listSessions: async () => {
          calls.push('list');
          return { sessions: [{ id: 'local_x', activity: { active: true, turn: {}, awaiting: 'answer' } }] };
        },
        loadSession: async () => ({}),
        getSessionActivity: async () => {
          calls.push('activity');
          return { active: true, kind: 'responding', label: 'x', updatedAt: 1, turn: { reply: '' } };
        },
        getSessionElicitation: async () => ({}),
        respondToSessionElicitation: async () => ({}),
        getSessionPermission: async () => null,
        respondToSessionPermission: async () => ({}),
        cancelSession: async () => ({}),
        promptSession: async () => ({}),
        getCreateOptions: async () => ({}),
        createSession: async () => ({ sessionId: 'local_x' }),
        revokeDevice: async () => ({}),
      };
    },
    onPending: (pending) => calls.push(`pending:${pending.length}`),
    now: () => clock.value,
    setTimeout: fakeSetTimeout,
  });

  scheduler.setBridgeIds(['bridge_a']);
  scheduler.setOpenSession('bridge_a', 'local_x');
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = scheduler.getSnapshot();
  check('scheduler list ran', calls.includes('list'));
  check('scheduler activity ran', calls.includes('activity'));
  check('scheduler saw pending', snapshot.pendingCount === 1);
  check('scheduler bridge online', snapshot.bridges['bridge_a']?.state === 'online');
  check('open session tracked', snapshot.openSession?.sessionId === 'local_x');
  scheduler.stop();
}

// ---------------------------------------------------------------------------
// client-core protocol seam
{
  try {
    requireClientCoreProtocol();
    check('protocol seam reports unwired', false);
  } catch (error) {
    check(
      'protocol seam reports unwired',
      error instanceof Error && 'code' in error && error.code === 'client_core_unavailable',
    );
  }
}

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
