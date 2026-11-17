import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import { canonicalJson } from '../../bridge/src/canonical';
import { InMemoryReplayGuard } from '../../bridge/src/replay';
import { authorizeRequest, signingPayload, type DeviceStore } from '../../bridge/src/security';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMethod,
  type BridgePermission,
  type DeviceRecord,
  type SignedRequestEnvelope,
} from '../../bridge/src/schemas';

const NOW = 1_800_000_000_000;
const BRIDGE_ID = 'bridge_1234567890';
const DEVICE_ID = 'device_1234567890';
const ALL_PERMISSIONS: BridgePermission[] = [
  'bridge:health',
  'session:metadata:read',
  'session:content:read',
  'session:prompt:send',
];

describe('Desktop Bridge security core', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let device: DeviceRecord;
  let devices: DeviceStore;

  beforeEach(() => {
    device = {
      bridgeId: BRIDGE_ID,
      deviceId: DEVICE_ID,
      deviceName: 'Frank’s iPhone',
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      status: 'active',
      pairedAt: NOW - 60_000,
      permissions: [...ALL_PERMISSIONS],
    };
    devices = {
      get: (deviceId) => (deviceId === DEVICE_ID ? device : undefined),
    };
  });

  function signedEnvelope(
    method: BridgeMethod,
    body: unknown,
    overrides: Partial<Omit<SignedRequestEnvelope, 'signature'>> = {},
  ): SignedRequestEnvelope {
    const unsigned: Omit<SignedRequestEnvelope, 'signature'> = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: BRIDGE_ID,
      deviceId: DEVICE_ID,
      requestId: randomUUID(),
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      nonce: randomBytes(24).toString('base64url'),
      method,
      body,
      ...overrides,
    };
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(signingPayload(unsigned), 'utf8'), privateKey).toString(
        'base64url',
      ),
    };
  }

  function authorize(input: unknown, replayGuard = new InMemoryReplayGuard()) {
    return authorizeRequest(input, {
      bridgeId: BRIDGE_ID,
      devices,
      replayGuard,
      now: NOW,
    });
  }

  it('canonicalizes object keys recursively for stable signatures', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: ['value', null] } })).toBe(
      canonicalJson({ a: { b: ['value', null], y: true }, z: 1 }),
    );
  });

  it('authorizes a correctly signed and permitted request', () => {
    const result = authorize(signedEnvelope('session.list', {}));

    expect(result).toMatchObject({
      ok: true,
      request: {
        method: 'session.list',
        body: {},
        device: { deviceId: DEVICE_ID },
      },
    });
  });

  it('rejects a body changed after signing without leaking the reason', () => {
    const envelope = signedEnvelope('session.prompt', {
      sessionId: 'session-one',
      text: 'original',
    });
    envelope.body = { sessionId: 'session-one', text: 'tampered' };

    expect(authorize(envelope)).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
      auditCategory: 'authentication',
    });
  });

  it('rejects replay of an otherwise valid request', () => {
    const replayGuard = new InMemoryReplayGuard();
    const envelope = signedEnvelope('bridge.health', {});

    expect(authorize(envelope, replayGuard).ok).toBe(true);
    expect(authorize(envelope, replayGuard)).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
      auditCategory: 'replay',
    });
  });

  it('limits replay entries per device before global capacity is exhausted', () => {
    const replayGuard = new InMemoryReplayGuard(4, 2);

    expect(replayGuard.consume(DEVICE_ID, 'nonce-one', NOW + 1_000, NOW)).toBe(true);
    expect(replayGuard.consume(DEVICE_ID, 'nonce-two', NOW + 1_000, NOW)).toBe(true);
    expect(replayGuard.consume(DEVICE_ID, 'nonce-three', NOW + 1_000, NOW)).toBe(false);
    expect(replayGuard.consume('different-device', 'nonce-one', NOW + 1_000, NOW)).toBe(true);
  });

  it.each([
    ['expired', { issuedAt: NOW - 60_000, expiresAt: NOW - 10_000 }],
    ['future-dated', { issuedAt: NOW + 10_000, expiresAt: NOW + 20_000 }],
    ['overlong', { issuedAt: NOW, expiresAt: NOW + 60_000 }],
  ])('rejects %s signed requests', (_label, overrides) => {
    expect(authorize(signedEnvelope('bridge.health', {}, overrides))).toMatchObject({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
      auditCategory: 'authentication',
    });
  });

  it.each([
    ['revoked device', () => (device.status = 'revoked' as const)],
    ['wrong bridge', () => (device.bridgeId = 'bridge_0987654321')],
    ['missing permission', () => (device.permissions = [])],
  ])('uses the same not-found response for a %s', (_label, arrange) => {
    arrange();

    const result = authorize(signedEnvelope('session.list', {}));
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('returns a generic validation response for an authenticated invalid body', () => {
    const result = authorize(signedEnvelope('session.load', {}));

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_request' },
      auditCategory: 'validation',
    });
  });

  it('enforces a device session scope server-side', () => {
    device.allowedSessionIds = ['allowed-session'];

    expect(
      authorize(signedEnvelope('session.load', { sessionId: 'different-session' })),
    ).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
      auditCategory: 'authorization',
    });
  });

  const scopedMethods: Array<[BridgeMethod, Record<string, unknown>]> = [
    ['session.load', {}],
    ['session.activity', {}],
    ['session.prompt', { text: 'Synthetic request' }],
    ['session.permission', {}],
    ['session.permission.respond', { permissionId: `permission_${'P'.repeat(43)}`, decision: 'allow_once' }],
    ['session.elicitation', {}],
    ['session.elicitation.respond', { interactionId: `interaction_${'I'.repeat(43)}`, action: 'cancel' }],
    ['session.cancel', {}],
  ];

  it.each(scopedMethods)('enforces session restrictions for %s', (method, extra) => {
    const body = { sessionId: 'allowed-session', ...extra };
    device.allowedSessionIds = ['allowed-session'];
    expect(authorize(signedEnvelope(method, body)).ok).toBe(true);
    expect(authorize(signedEnvelope(method, { ...body, sessionId: 'outside-scope' }))).toMatchObject({
      ok: false, status: 404, body: { error: 'not_found' }, auditCategory: 'authorization',
    });
    device.allowedSessionIds = [];
    expect(authorize(signedEnvelope(method, body))).toMatchObject({ ok: false, auditCategory: 'authorization' });
    device.allowedSessionIds = undefined;
    expect(authorize(signedEnvelope(method, body)).ok).toBe(true);
  });

  it('fails closed when an unsigned envelope field is added', () => {
    const envelope = {
      ...signedEnvelope('bridge.health', {}),
      unexpected: 'field',
    };

    expect(authorize(envelope)).toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_request' },
      auditCategory: 'validation',
    });
  });
});
