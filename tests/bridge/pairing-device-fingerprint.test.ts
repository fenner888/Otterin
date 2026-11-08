import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  CONNECTOR_IPC_VERSION,
  connectorEventSchema,
  encodeConnectorEvent,
} from '../../bridge/src/connector-ipc';
import {
  PairingManager,
  createPairingProof,
  type PairingDeviceRegistry,
  type PairingOffer,
  type PairingRequest,
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

describe('pairing review device key fingerprint', () => {
  const bridgeKeys = generateKeyPairSync('ed25519');
  const bridgePublicKeySpki = bridgeKeys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const devicePublicKeySpki = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const registry: PairingDeviceRegistry = {
    register: async () => true,
  };
  const manager = new PairingManager(
    {
      bridgeId: BRIDGE_ID,
      privateKey: bridgeKeys.privateKey,
      publicKeySpki: bridgePublicKeySpki,
    },
    registry,
  );

  function pairingRequest(offer: PairingOffer): PairingRequest {
    const unsigned: UnsignedPairingRequest = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: offer.bridgeId,
      pairingId: offer.pairingId,
      bridgeKeyFingerprint: offer.bridgeKeyFingerprint,
      transportSecurity: offer.transportSecurity,
      bridgeEndpoint: offer.bridgeEndpoint,
      tlsCertificateFingerprint: offer.tlsCertificateFingerprint,
      deviceId: DEVICE_ID,
      deviceName: 'Otterin (Mac)',
      devicePublicKeySpki,
    };
    return {
      ...unsigned,
      proof: createPairingProof(offer.pairingSecret, unsigned),
    };
  }

  it('carries the truncated sha256-over-SPKI-DER fingerprint of the submitting key', () => {
    const offer = manager.createOffer(TRANSPORT, NOW);
    const submission = manager.submit(pairingRequest(offer), NOW + 1);
    if (!submission.ok) throw new Error('Expected pending pairing');

    // Same construction as bridgeKeyFingerprint, truncated to a comparable SAS.
    const expected = createHash('sha256')
      .update(Buffer.from(devicePublicKeySpki, 'base64url'))
      .digest('base64url')
      .slice(0, 12);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(submission.pending.deviceKeyFingerprint).toBe(expected);
    expect(manager.pendingReviews(NOW + 2)).toEqual([
      {
        pairingId: offer.pairingId,
        deviceId: DEVICE_ID,
        deviceName: 'Otterin (Mac)',
        deviceKeyFingerprint: expected,
        expiresAt: NOW + 1 + 300_000,
      },
    ]);
    // A different device key must produce a different fingerprint.
    const otherSpki = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url');
    const other = createHash('sha256')
      .update(Buffer.from(otherSpki, 'base64url'))
      .digest('base64url')
      .slice(0, 12);
    expect(other).not.toBe(expected);
  });

  it('round-trips the fingerprint through the pairing_review connector event', () => {
    const line = encodeConnectorEvent({
      version: CONNECTOR_IPC_VERSION,
      type: 'pairing_review',
      pairingId: 'pairing_1234567890abcdef',
      deviceName: 'Otterin (Mac)',
      deviceKeyFingerprint: 'Ab3d-ef_1234',
      expiresAt: NOW,
    });
    expect(connectorEventSchema.parse(JSON.parse(line))).toEqual({
      version: CONNECTOR_IPC_VERSION,
      type: 'pairing_review',
      pairingId: 'pairing_1234567890abcdef',
      deviceName: 'Otterin (Mac)',
      deviceKeyFingerprint: 'Ab3d-ef_1234',
      expiresAt: NOW,
    });
  });

  it('still validates a pairing_review event emitted without the fingerprint', () => {
    expect(
      connectorEventSchema.parse({
        version: CONNECTOR_IPC_VERSION,
        type: 'pairing_review',
        pairingId: 'pairing_1234567890abcdef',
        deviceName: 'Frank’s iPhone',
        expiresAt: NOW,
      }),
    ).toEqual({
      version: CONNECTOR_IPC_VERSION,
      type: 'pairing_review',
      pairingId: 'pairing_1234567890abcdef',
      deviceName: 'Frank’s iPhone',
      expiresAt: NOW,
    });
    // And the fingerprint is validated when present: non-base64url input fails.
    expect(() =>
      encodeConnectorEvent({
        version: CONNECTOR_IPC_VERSION,
        type: 'pairing_review',
        pairingId: 'pairing_1234567890abcdef',
        deviceName: 'Otterin (Mac)',
        deviceKeyFingerprint: 'not base64url!!',
        expiresAt: NOW,
      }),
    ).toThrow();
  });
});
