import {
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

import { canonicalJson } from '../../client-core/src/canonicalJson';
import { openComputerBridge } from '../../client-core/src/computerBridge';
import { InMemoryReplayGuard } from '../../bridge/src/replay';
import { authorizeRequest, signingPayload, type DeviceStore } from '../../bridge/src/security';
import {
  signedRequestEnvelopeSchema,
  type BridgeMethod,
  type DeviceRecord,
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

const NOW = 1_800_000_000_000;

// Golden Ed25519 vector: fixed pkcs8 + fixed unsigned envelope -> fixed
// deterministic signature. Oracle values generated with node:crypto (the
// same recipe mac-client's crypto.node.ts will use).
const GOLDEN_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIEJLTVVBvsk8MJbCIyYPgNW52CyP4bkdIIQMfVDDTwUY
-----END PRIVATE KEY-----`;
const GOLDEN_SPKI = 'MCowBQYDK2VwAyEAA2wGhM10HPZ3Z770L9n1cgQ3NAllWqOCEhtLqtWRhY0';
const GOLDEN_UNSIGNED = {
  protocolVersion: 2 as const,
  bridgeId: 'bridge_1234567890',
  deviceId: 'device_1234567890',
  requestId: '11111111-2222-4333-8444-555555555555',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_015_000,
  nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  method: 'bridge.health' as const,
  body: {},
};
const GOLDEN_PAYLOAD =
  '{"body":{},"bridgeId":"bridge_1234567890","deviceId":"device_1234567890","expiresAt":1800000015000,"issuedAt":1800000000000,"method":"bridge.health","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","protocolVersion":2,"requestId":"11111111-2222-4333-8444-555555555555"}';
const GOLDEN_SIGNATURE =
  'wfK3SBhfRqKaFGVScUQ52XaCRS6XfK8UeK9BW6v772eraglmrFUHDXJxOufPJ8jdCTNBAhWKdiLj-HyxmVe2DQ';

function deviceStoreFor(record: DeviceRecord): DeviceStore {
  return { get: (deviceId) => (deviceId === record.deviceId ? record : undefined) };
}

describe('client-core signed envelope', () => {
  let crypto: NodeDeviceCrypto;
  let transport: RecordingTransport;
  let store: InMemorySecretStore;

  beforeEach(() => {
    crypto = new NodeDeviceCrypto();
    transport = new RecordingTransport(() => ({ status: 200, body: { sessions: [] } }));
    store = new InMemorySecretStore();
    registerPorts(crypto, transport, store);
  });

  it('produces the golden signature for a fixed key and payload', async () => {
    const privateKey = createPrivateKey(GOLDEN_PKCS8);
    expect(canonicalJson(GOLDEN_UNSIGNED)).toBe(GOLDEN_PAYLOAD);
    expect(signingPayload(GOLDEN_UNSIGNED)).toBe(GOLDEN_PAYLOAD);

    const expected = nodeSign(null, Buffer.from(GOLDEN_PAYLOAD, 'utf8'), privateKey).toString(
      'base64url',
    );
    expect(expected).toBe(GOLDEN_SIGNATURE);

    // The DeviceCrypto port recipe yields identical bytes.
    const keyId = randomUUID();
    crypto.importIdentity(keyId, privateKey);
    await expect(crypto.sign(keyId, canonicalJson(GOLDEN_UNSIGNED))).resolves.toBe(
      GOLDEN_SIGNATURE,
    );

    // And it verifies against the exported SPKI.
    await expect(
      crypto.verify(GOLDEN_SPKI, GOLDEN_PAYLOAD, GOLDEN_SIGNATURE),
    ).resolves.toBe(true);
  });

  it('signs a full envelope that the real bridge authorizeRequest accepts', async () => {
    const { credential, deviceId, publicKeySpki } = await seedPairedComputer({ crypto });
    const connection = await openComputerBridge(credential.bridgeId);
    await connection.listSessions({});

    const posted = transport.envelopes()[0];
    expect(posted).toBeDefined();
    const roundTripped = JSON.parse(JSON.stringify(posted)) as unknown;
    expect(signedRequestEnvelopeSchema.safeParse(roundTripped).success).toBe(true);

    const device: DeviceRecord = {
      bridgeId: credential.bridgeId,
      deviceId,
      deviceName: 'Otterin (Mac)',
      publicKeySpki,
      status: 'active',
      pairedAt: NOW - 60_000,
      permissions: [...credential.permissions],
    };
    const result = authorizeRequest(roundTripped, {
      bridgeId: credential.bridgeId,
      devices: deviceStoreFor(device),
      replayGuard: new InMemoryReplayGuard(),
      now: Date.now(),
    });

    expect(result).toMatchObject({
      ok: true,
      request: {
        method: 'session.list',
        body: {},
        device: { deviceId },
      },
    });
  });

  describe('replay and timing edges through authorizeRequest', () => {
    let deviceId: string;
    let publicKeySpki: string;
    let device: DeviceRecord;
    let deviceKeyId: string;

    beforeEach(async () => {
      const seeded = await seedPairedComputer({ crypto });
      deviceId = seeded.deviceId;
      publicKeySpki = seeded.publicKeySpki;
      deviceKeyId = seeded.credential.deviceKeyId;
      device = {
        bridgeId: TEST_BRIDGE_ID,
        deviceId,
        deviceName: 'Otterin (Mac)',
        publicKeySpki,
        status: 'active',
        pairedAt: NOW - 60_000,
        permissions: [...seeded.credential.permissions],
      };
    });

    async function signEnvelope(
      method: BridgeMethod,
      body: unknown,
      overrides: Partial<Omit<SignedRequestEnvelope, 'signature'>> = {},
    ): Promise<SignedRequestEnvelope> {
      const unsigned = {
        protocolVersion: 2 as const,
        bridgeId: TEST_BRIDGE_ID,
        deviceId,
        requestId: randomUUID(),
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 10_000,
        nonce: randomBytes(24).toString('base64url'),
        method,
        body,
        ...overrides,
      };
      const signature = await crypto.sign(deviceKeyId, canonicalJson(unsigned));
      return { ...unsigned, signature };
    }

    function authorize(input: unknown, replayGuard = new InMemoryReplayGuard()) {
      return authorizeRequest(input, {
        bridgeId: TEST_BRIDGE_ID,
        devices: deviceStoreFor(device),
        replayGuard,
        now: NOW,
      });
    }

    it('rejects an expired envelope', async () => {
      const envelope = await signEnvelope('bridge.health', {}, {
        issuedAt: NOW - 60_000,
        expiresAt: NOW - 10_000,
      });
      expect(authorize(envelope)).toMatchObject({
        ok: false,
        status: 404,
        body: { error: 'not_found' },
        auditCategory: 'authentication',
      });
    });

    it('rejects a future-dated envelope beyond clock skew', async () => {
      const envelope = await signEnvelope('bridge.health', {}, {
        issuedAt: NOW + 10_000,
        expiresAt: NOW + 20_000,
      });
      expect(authorize(envelope)).toMatchObject({
        ok: false,
        status: 404,
        auditCategory: 'authentication',
      });
    });

    it('rejects an overlong request lifetime', async () => {
      const envelope = await signEnvelope('bridge.health', {}, {
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      });
      expect(authorize(envelope)).toMatchObject({
        ok: false,
        status: 404,
        auditCategory: 'authentication',
      });
    });

    it('rejects replay of a client-core-signed envelope', async () => {
      const replayGuard = new InMemoryReplayGuard();
      const envelope = await signEnvelope('bridge.health', {});
      expect(authorize(envelope, replayGuard).ok).toBe(true);
      expect(authorize(envelope, replayGuard)).toEqual({
        ok: false,
        status: 404,
        body: { error: 'not_found' },
        auditCategory: 'replay',
      });
    });

    it('rejects a body tampered with after signing', async () => {
      const envelope = await signEnvelope('session.list', {});
      envelope.body = { cursor: 'injected' };
      expect(authorize(envelope)).toMatchObject({
        ok: false,
        status: 404,
        auditCategory: 'authentication',
      });
    });

    it('rejects a signature over a different payload', async () => {
      const good = await signEnvelope('bridge.health', {});
      const other = await signEnvelope('session.list', {});
      other.signature = good.signature;
      expect(authorize(other)).toMatchObject({
        ok: false,
        status: 404,
        auditCategory: 'authentication',
      });
    });

    it('verifies the envelope signature against the unsigned fields', async () => {
      const envelope = await signEnvelope('session.list', { cursor: 'c' });
      const { signature, ...unsigned } = envelope;
      expect(
        nodeVerify(
          null,
          Buffer.from(canonicalJson(unsigned), 'utf8'),
          { key: Buffer.from(publicKeySpki, 'base64url'), format: 'der', type: 'spki' },
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    });
  });

  it('mints a fresh requestId and nonce per envelope', async () => {
    const { credential } = await seedPairedComputer({ crypto });
    const connection = await openComputerBridge(credential.bridgeId);
    await connection.listSessions({});
    await connection.listSessions({});

    const envelopes = transport.envelopes() as unknown as SignedRequestEnvelope[];
    const first = envelopes[0]!;
    const second = envelopes[1]!;
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.signature).not.toBe(second.signature);
    expect(second.expiresAt - second.issuedAt).toBe(15_000);
  });
});
