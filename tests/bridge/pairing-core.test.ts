import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

import {
  PairingManager,
  createPairingProof,
  defaultComputerName,
  revokeDeviceRecord,
  updateDevicePermissions,
  verifyPairingReceipt,
  type PairingOffer,
  type PairingRequest,
  type PairingDeviceRegistry,
  type UnsignedPairingRequest,
} from '../../bridge/src/pairing';
import { BRIDGE_PROTOCOL_VERSION } from '../../bridge/src/schemas';

const NOW = 1_800_000_000_000;
const BRIDGE_ID = 'bridge_1234567890';
const DEVICE_ID = 'device_1234567890';
const TRANSPORT = {
  transportSecurity: 'pinned_tls' as const,
  bridgeEndpoint: 'https://192.168.1.20:45831/',
  tlsCertificateFingerprint: 'T'.repeat(43),
};

describe('Desktop Bridge pairing core', () => {
  const bridgeKeys = generateKeyPairSync('ed25519');
  const bridgePublicKeySpki = bridgeKeys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  let devicePublicKeySpki: string;
  let registeredDevices: Map<string, unknown>;
  let registry: PairingDeviceRegistry;
  let manager: PairingManager;

  beforeEach(() => {
    devicePublicKeySpki = generateKeyPairSync('ed25519')
      .publicKey.export({
        format: 'der',
        type: 'spki',
      })
      .toString('base64url');
    registeredDevices = new Map();
    registry = {
      register: async (device) => {
        if (registeredDevices.has(device.deviceId)) return false;
        registeredDevices.set(device.deviceId, device);
        return true;
      },
    };
    manager = new PairingManager(
      {
        bridgeId: BRIDGE_ID,
        privateKey: bridgeKeys.privateKey,
        publicKeySpki: bridgePublicKeySpki,
      },
      registry,
    );
  });

  function pairingRequest(
    offer: PairingOffer,
    overrides: Partial<UnsignedPairingRequest> = {},
  ): PairingRequest {
    const unsigned: UnsignedPairingRequest = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: offer.bridgeId,
      pairingId: offer.pairingId,
      bridgeKeyFingerprint: offer.bridgeKeyFingerprint,
      transportSecurity: offer.transportSecurity,
      bridgeEndpoint: offer.bridgeEndpoint,
      tlsCertificateFingerprint: offer.tlsCertificateFingerprint,
      deviceId: DEVICE_ID,
      deviceName: 'Frank’s iPhone',
      devicePublicKeySpki,
      ...overrides,
    };
    return {
      ...unsigned,
      proof: createPairingProof(offer.pairingSecret, unsigned),
    };
  }

  it('creates a short-lived offer pinned to the bridge public key', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const fingerprint = createHash('sha256')
      .update(Buffer.from(bridgePublicKeySpki, 'base64url'))
      .digest('base64url');

    expect(offer).toMatchObject({
      protocolVersion: 2,
      bridgeId: BRIDGE_ID,
      bridgePublicKeySpki,
      bridgeKeyFingerprint: fingerprint,
      ...TRANSPORT,
      expiresAt: NOW + 120_000,
    });
    expect(Buffer.from(offer.pairingSecret, 'base64url')).toHaveLength(32);
    expect(offer.computerName).toBeUndefined();
  });

  it('includes a configured computer name in the pairing offer', () => {
    const configured = new PairingManager(
      {
        bridgeId: BRIDGE_ID,
        privateKey: bridgeKeys.privateKey,
        publicKeySpki: bridgePublicKeySpki,
      },
      registry,
      { computerName: 'Marks-Mac-mini' },
    );

    expect(configured.createOffer(TRANSPORT, NOW).computerName).toBe('Marks-Mac-mini');
  });

  it.each([
    ['Marks-Mac-mini.local', 'Marks-Mac-mini'],
    ['', undefined],
    ['a'.repeat(100), 'a'.repeat(80)],
    ['Mac\u0000\u001bName\u007f', 'MacName'],
  ])('normalizes the default computer name %s', (hostname, expected) => {
    expect(defaultComputerName(hostname)).toBe(expected);
  });

  it('rejects an overlong configured computer name', () => {
    expect(
      () =>
        new PairingManager(
          {
            bridgeId: BRIDGE_ID,
            privateKey: bridgeKeys.privateKey,
            publicKeySpki: bridgePublicKeySpki,
          },
          registry,
          { computerName: 'a'.repeat(200) },
        ),
    ).toThrow();
  });

  it('requires desktop approval and grants only read-only defaults', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const request = pairingRequest(offer);

    const submission = manager.submit(request, NOW + 1_000);
    expect(submission).toMatchObject({
      ok: true,
      pending: {
        pairingId: offer.pairingId,
        deviceId: DEVICE_ID,
        deviceName: 'Frank’s iPhone',
      },
    });
    if (!submission.ok) throw new Error('Expected pending pairing');
    expect(manager.pendingReviews(NOW + 1_250)).toEqual([
      {
        pairingId: offer.pairingId,
        deviceId: DEVICE_ID,
        deviceName: 'Frank’s iPhone',
        deviceKeyFingerprint: createHash('sha256')
          .update(Buffer.from(devicePublicKeySpki, 'base64url'))
          .digest('base64url')
          .slice(0, 12),
        expiresAt: NOW + 1_000 + 300_000,
      },
    ]);
    expect(JSON.stringify(manager.pendingReviews(NOW + 1_250))).not.toContain(submission.pollToken);
    expect(
      manager.poll(
        {
          protocolVersion: 2,
          bridgeId: BRIDGE_ID,
          pairingId: offer.pairingId,
          pollToken: submission.pollToken,
        },
        NOW + 1_500,
      ),
    ).toMatchObject({ ok: true, status: 202, body: { status: 'pending' } });
    expect(manager.submit(request, NOW + 2_000)).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });

    const approval = await manager.approve(offer.pairingId, NOW + 3_000);
    expect(approval).toMatchObject({
      ok: true,
      device: {
        bridgeId: BRIDGE_ID,
        deviceId: DEVICE_ID,
        deviceName: 'Frank’s iPhone',
        status: 'active',
        pairedAt: NOW + 3_000,
        permissions: ['bridge:health', 'session:metadata:read'],
      },
    });
    if (!approval.ok) throw new Error('Expected pairing approval');
    expect(approval.device.permissions).not.toContain('session:content:read');
    expect(approval.device.permissions).not.toContain('session:prompt:send');
    expect(registeredDevices.get(DEVICE_ID)).toEqual(approval.device);
    approval.device.permissions.push('session:content:read');
    expect(registeredDevices.get(DEVICE_ID)).toMatchObject({
      permissions: ['bridge:health', 'session:metadata:read'],
    });
    expect(manager.verifyReceipt(approval.receipt, TRANSPORT)).toBe(true);
    expect(verifyPairingReceipt(approval.receipt, bridgePublicKeySpki, BRIDGE_ID, TRANSPORT)).toBe(
      true,
    );
    const approvedPoll = manager.poll(
      {
        protocolVersion: 2,
        bridgeId: BRIDGE_ID,
        pairingId: offer.pairingId,
        pollToken: submission.pollToken,
      },
      NOW + 3_001,
    );
    expect(approvedPoll).toMatchObject({
      ok: true,
      status: 200,
      body: { status: 'approved', receipt: approval.receipt },
    });
    expect(
      manager.poll(
        {
          protocolVersion: 2,
          bridgeId: BRIDGE_ID,
          pairingId: offer.pairingId,
          pollToken: submission.pollToken,
        },
        NOW + 3_002,
      ),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it('adds session content only through the explicit read-only approval option', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const submission = manager.submit(pairingRequest(offer), NOW + 1);
    if (!submission.ok) throw new Error('Expected pending pairing');

    const approval = await manager.approve(offer.pairingId, NOW + 2, {
      allowSessionContent: true,
    });

    expect(approval).toMatchObject({
      ok: true,
      device: {
        permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
      },
      receipt: {
        permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
      },
    });
    expect(registeredDevices.get(DEVICE_ID)).toMatchObject({
      permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
    });
    if (!approval.ok) throw new Error('Expected pairing approval');
    expect(approval.device.permissions).not.toContain('session:prompt:send');
  });

  it('invalidates an offer after repeated incorrect proofs', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const request = pairingRequest(offer);
    request.proof = randomBytes(32).toString('base64url');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(manager.submit(request, NOW + attempt)).toEqual({
        ok: false,
        status: 404,
        body: { error: 'not_found' },
      });
    }
    const validRequest = pairingRequest(offer);
    expect(manager.submit(validRequest, NOW + 10)).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('keeps the stored offer isolated from mutations to the returned QR object', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const request = pairingRequest(offer);
    offer.pairingSecret = randomBytes(32).toString('base64url');
    offer.expiresAt = NOW;

    expect(manager.submit(request, NOW + 1).ok).toBe(true);
  });

  it('rejects expired offers without disclosing their state', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);

    expect(manager.submit(pairingRequest(offer), NOW + 120_001)).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('rejects invalid lifecycle clocks before changing pairing state', () => {
    expect(() => manager.createOffer(TRANSPORT, Number.NaN)).toThrow('lifecycle time');
    const offer = manager.createOffer(TRANSPORT, NOW);
    expect(() => manager.submit(pairingRequest(offer), Number.MAX_VALUE)).toThrow('lifecycle time');
    expect(manager.submit(pairingRequest(offer), NOW + 1).ok).toBe(true);
  });

  it('binds a valid pairing proof to the QR endpoint and TLS fingerprint', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const request = pairingRequest(offer, {
      bridgeEndpoint: 'https://192.168.1.99:45831/',
    });

    expect(manager.submit(request, NOW + 1)).toMatchObject({ ok: false, status: 404 });
    expect(manager.submit(pairingRequest(offer), NOW + 2)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('rejects a non-Ed25519 device key and consumes the offer', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url');
    const request = pairingRequest(offer, { devicePublicKeySpki: rsaPublicKey });

    expect(manager.submit(request, NOW + 1)).toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(manager.submit(pairingRequest(offer), NOW + 2)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('supports explicit denial and prevents later approval', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const submission = manager.submit(pairingRequest(offer), NOW + 1);
    expect(submission.ok).toBe(true);
    if (!submission.ok) throw new Error('Expected pending pairing');

    expect(manager.deny(offer.pairingId)).toBe(true);
    await expect(manager.approve(offer.pairingId, NOW + 2)).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });
    expect(
      manager.poll(
        {
          protocolVersion: 2,
          bridgeId: BRIDGE_ID,
          pairingId: offer.pairingId,
          pollToken: submission.pollToken,
        },
        NOW + 3,
      ),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it('does not overwrite an existing device public key', async () => {
    registeredDevices.set(DEVICE_ID, { existing: true });
    const offer = manager.createOffer(TRANSPORT, NOW);
    manager.submit(pairingRequest(offer), NOW + 1);

    await expect(manager.approve(offer.pairingId, NOW + 2)).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'not_found' },
    });
    expect(registeredDevices.get(DEVICE_ID)).toEqual({ existing: true });
  });

  it('detects a tampered approval receipt', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    manager.submit(pairingRequest(offer), NOW + 1);
    const approval = await manager.approve(offer.pairingId, NOW + 2);
    if (!approval.ok) throw new Error('Expected pairing approval');

    const tampered = {
      ...approval.receipt,
      permissions: [...approval.receipt.permissions, 'session:prompt:send'],
    };
    expect(verifyPairingReceipt(tampered, bridgePublicKeySpki, BRIDGE_ID, TRANSPORT)).toBe(false);
    expect(
      verifyPairingReceipt(approval.receipt, bridgePublicKeySpki, 'bridge_0987654321', TRANSPORT),
    ).toBe(false);
    expect(
      verifyPairingReceipt(approval.receipt, bridgePublicKeySpki, BRIDGE_ID, {
        ...TRANSPORT,
        tlsCertificateFingerprint: 'W'.repeat(43),
      }),
    ).toBe(false);
  });

  it('supports explicit permission updates and revocation', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    manager.submit(pairingRequest(offer), NOW + 1);
    const approval = await manager.approve(offer.pairingId, NOW + 2);
    if (!approval.ok) throw new Error('Expected pairing approval');

    const updated = updateDevicePermissions(approval.device, {
      permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
      allowedSessionIds: ['approved-session'],
    });
    expect(updated).toMatchObject({
      permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
      allowedSessionIds: ['approved-session'],
    });
    expect(revokeDeviceRecord(updated).status).toBe('revoked');
  });

  it('rejects duplicate permission or session-scope updates', async () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    manager.submit(pairingRequest(offer), NOW + 1);
    const approval = await manager.approve(offer.pairingId, NOW + 2);
    if (!approval.ok) throw new Error('Expected pairing approval');

    expect(() =>
      updateDevicePermissions(approval.device, {
        permissions: ['bridge:health', 'bridge:health'],
      }),
    ).toThrow();
    expect(() =>
      updateDevicePermissions(approval.device, {
        permissions: ['bridge:health'],
        allowedSessionIds: ['same-session', 'same-session'],
      }),
    ).toThrow();
  });

  it('rejects mismatched bridge identity keys', () => {
    const otherKey = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url');

    expect(
      () =>
        new PairingManager(
          {
            bridgeId: BRIDGE_ID,
            privateKey: bridgeKeys.privateKey,
            publicKeySpki: otherKey,
          },
          registry,
        ),
    ).toThrow('keys do not match');
  });
});
