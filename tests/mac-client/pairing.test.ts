import { createHash, generateKeyPairSync } from 'node:crypto';

import { canonicalJson } from '../../client-core/src/canonicalJson';
import { hmacSha256 } from '../../client-core/src/deviceSigning';
import {
  ComputerPairingOfferError,
  pairComputerFromQrPayload,
  setComputerPairingRuntimeForTests,
} from '../../client-core/src/computerPairing';
import { loadPairedComputers } from '../../client-core/src/pairedComputers';
import { canonicalJson as bridgeCanonicalJson } from '../../bridge/src/canonical';
import {
  PairingManager,
  createPairingProof,
  pairingRequestSchema,
  verifyPairingReceipt,
  type PairingDeviceRegistry,
  type PairingOffer,
  type SignedPairingReceipt,
  type UnsignedPairingRequest,
} from '../../bridge/src/pairing';
import type { BridgePostResult } from '../../client-core/src/ports';
import {
  InMemorySecretStore,
  NodeDeviceCrypto,
  RecordingTransport,
  registerPorts,
  seedPairedComputer,
} from './helpers';

const NOW = 1_800_000_000_000;
const BRIDGE_ID = 'bridge_1234567890';
const ENDPOINT = 'http://100.64.1.5:45831/';
const NEW_ENDPOINT = 'http://100.64.1.6:45831/';
const TRANSPORT = {
  transportSecurity: 'tailscale_wireguard' as const,
  bridgeEndpoint: ENDPOINT,
  tlsCertificateFingerprint: 'T'.repeat(43),
};
const NEW_TRANSPORT = { ...TRANSPORT, bridgeEndpoint: NEW_ENDPOINT };

const HEALTH_BODY = {
  protocolVersion: 2,
  status: 'ready',
  capabilities: { sessionList: true, sessionLoad: true, sessionPrompt: true },
};

describe('client-core pairing vs bridge PairingManager', () => {
  const bridgeKeys = generateKeyPairSync('ed25519');
  const bridgePublicKeySpki = bridgeKeys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const bridgeKeyFingerprint = createHash('sha256')
    .update(Buffer.from(bridgePublicKeySpki, 'base64url'))
    .digest('base64url');

  let crypto: NodeDeviceCrypto;
  let store: InMemorySecretStore;
  let registryDevices: Map<string, unknown>;
  let manager: PairingManager;
  let clockNow: number;

  beforeEach(() => {
    crypto = new NodeDeviceCrypto();
    store = new InMemorySecretStore();
    // Ports are module-level singletons: register the fresh crypto + store now
    // (a throwing placeholder transport) so seeding and facade calls never hit
    // a stale registration from a previous test. Each test re-registers its
    // scripted transport before driving traffic.
    registerPorts(
      crypto,
      {
        postTailnetBridgeJson: () => {
          throw new Error('Transport not configured for this test');
        },
        postPinnedBridgeJson: () => {
          throw new Error('Transport not configured for this test');
        },
      },
      store,
    );
    registryDevices = new Map();
    const registry: PairingDeviceRegistry = {
      register: async (device) => {
        if (registryDevices.has(device.deviceId)) return false;
        registryDevices.set(device.deviceId, device);
        return true;
      },
    };
    manager = new PairingManager(
      { bridgeId: BRIDGE_ID, privateKey: bridgeKeys.privateKey, publicKeySpki: bridgePublicKeySpki },
      registry,
      { computerName: 'Test Connector Mac' },
    );
    clockNow = NOW;
    setComputerPairingRuntimeForTests({
      now: () => clockNow,
      wait: async (milliseconds) => {
        clockNow += milliseconds;
      },
    });
  });

  afterEach(() => {
    setComputerPairingRuntimeForTests(undefined);
  });

  /** Routes the client pairing posts into the real PairingManager. */
  function managerTransport(input: {
    approveOnPoll?: number;
    failPolls?: number[];
    denyOnPoll?: boolean;
    requestResult?: BridgePostResult;
    onApproved?: (receipt: SignedPairingReceipt) => void;
  } = {}): RecordingTransport {
    let pollCount = 0;
    const failPolls = new Set(input.failPolls ?? []);
    return new RecordingTransport(async (path, body) => {
      if (path === '/v1/pair/submit') {
        const result = manager.submit(body, clockNow);
        if (!result.ok) return { status: result.status, body: result.body };
        return {
          status: 202,
          body: {
            status: 'pending',
            pollToken: result.pollToken,
            expiresAt: result.pending.expiresAt,
          },
        };
      }
      if (path === '/v1/pair/status') {
        pollCount += 1;
        if (failPolls.has(pollCount)) throw new Error('connection reset');
        const pairingId = (body as { pairingId: string }).pairingId;
        if (input.denyOnPoll === true) {
          manager.deny(pairingId);
        } else if (pollCount === (input.approveOnPoll ?? 2)) {
          await manager.approve(pairingId, clockNow, { allowSessionContent: true });
        }
        const result = manager.poll(body, clockNow);
        if (!result.ok) return { status: result.status, body: result.body };
        if (result.status === 200) input.onApproved?.(result.body.receipt);
        return { status: result.status, body: result.body };
      }
      if (path === '/v1/request') {
        return input.requestResult ?? { status: 200, body: HEALTH_BODY };
      }
      throw new Error(`Unexpected path ${path}`);
    });
  }

  function seedExistingPairing(endpoint = ENDPOINT) {
    return seedPairedComputer({
      crypto,
      bridgeId: BRIDGE_ID,
      endpoint,
      bridgePublicKeySpki,
      bridgeKeyFingerprint,
      tlsCertificateFingerprint: TRANSPORT.tlsCertificateFingerprint,
    });
  }

  it('computes the same HMAC proof as bridge createPairingProof', async () => {
    const unsignedRequest: UnsignedPairingRequest = {
      protocolVersion: 2,
      bridgeId: BRIDGE_ID,
      pairingId: 'pairing_abcdefghij',
      bridgeKeyFingerprint: 'F'.repeat(43),
      transportSecurity: 'tailscale_wireguard',
      bridgeEndpoint: ENDPOINT,
      tlsCertificateFingerprint: 'T'.repeat(43),
      deviceId: 'device_0123456789abcdef',
      deviceName: 'Otterin (Mac)',
      devicePublicKeySpki: 'D'.repeat(59),
    };
    const pairingSecret = 's'.repeat(43);

    const clientProof = await hmacSha256(pairingSecret, canonicalJson(unsignedRequest));
    const bridgeProof = createPairingProof(pairingSecret, unsignedRequest);

    expect(clientProof).toBe(bridgeProof);
    expect(clientProof).toHaveLength(43);
    expect(canonicalJson(unsignedRequest)).toBe(bridgeCanonicalJson(unsignedRequest));
  });

  it('pairs end-to-end through the real PairingManager and stores a credential', async () => {
    const offer = manager.createOffer(TRANSPORT, clockNow);
    const transport = managerTransport({ approveOnPoll: 3 });
    registerPorts(crypto, transport, store);

    const summary = await pairComputerFromQrPayload(JSON.stringify(offer), {
      computerName: 'Ignored Name',
      useConnectorComputerName: true,
      deviceName: 'Otterin (Mac)',
    });

    // The submit reached the bridge as a schema-valid, proof-valid request.
    const submitPost = transport.posts.find((post) => post.path === '/v1/pair/submit');
    expect(submitPost).toBeDefined();
    expect(pairingRequestSchema.safeParse(submitPost!.body).success).toBe(true);
    const submitted = submitPost!.body as { deviceName: string; proof: string };
    expect(submitted.deviceName).toBe('Otterin (Mac)');
    expect(submitted.proof).toHaveLength(43);

    // The device was registered bridge-side.
    const registered = [...registryDevices.values()] as Array<{
      deviceId: string;
      deviceName: string;
      publicKeySpki: string;
    }>;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.deviceName).toBe('Otterin (Mac)');

    // The persisted credential matches the bridge-side record and carries the
    // content grant granted at approval.
    const computers = await loadPairedComputers();
    expect(computers).toHaveLength(1);
    const credential = computers[0]!;
    expect(credential.bridgeId).toBe(BRIDGE_ID);
    expect(credential.computerName).toBe('Test Connector Mac');
    expect(credential.deviceId).toBe(registered[0]!.deviceId);
    expect(credential.devicePublicKeySpki).toBe(registered[0]!.publicKeySpki);
    expect(credential.endpoint).toBe(ENDPOINT);
    expect(credential.permissions).toContain('session:content:read');
    expect(summary).toMatchObject({
      bridgeId: BRIDGE_ID,
      computerName: 'Test Connector Mac',
      transportKind: 'tailscale_vpn',
    });
  });

  it('verifies the delivered receipt with bridge verifyPairingReceipt', async () => {
    const offer = manager.createOffer(TRANSPORT, clockNow);
    let deliveredReceipt: SignedPairingReceipt | undefined;
    const transport = managerTransport({
      approveOnPoll: 1,
      onApproved: (receipt) => {
        deliveredReceipt = receipt;
      },
    });
    registerPorts(crypto, transport, store);
    await pairComputerFromQrPayload(JSON.stringify(offer), { computerName: 'Test Mac' });

    expect(deliveredReceipt).toBeDefined();
    expect(
      verifyPairingReceipt(deliveredReceipt, bridgePublicKeySpki, BRIDGE_ID, TRANSPORT),
    ).toBe(true);
    expect(
      verifyPairingReceipt(
        { ...deliveredReceipt!, deviceId: 'device_tampered0000' },
        bridgePublicKeySpki,
        BRIDGE_ID,
        TRANSPORT,
      ),
    ).toBe(false);
    const otherKeys = generateKeyPairSync('ed25519');
    expect(
      verifyPairingReceipt(
        deliveredReceipt,
        otherKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        BRIDGE_ID,
        TRANSPORT,
      ),
    ).toBe(false);
  });

  it('tolerates transient transport failures during approval polling', async () => {
    const offer = manager.createOffer(TRANSPORT, clockNow);
    const transport = managerTransport({ approveOnPoll: 4, failPolls: [1, 2] });
    registerPorts(crypto, transport, store);

    await expect(
      pairComputerFromQrPayload(JSON.stringify(offer), { computerName: 'Test Mac' }),
    ).resolves.toMatchObject({ bridgeId: BRIDGE_ID });
    await expect(loadPairedComputers()).resolves.toHaveLength(1);
  });

  it('fails the ceremony when approval is denied', async () => {
    const offer = manager.createOffer(TRANSPORT, clockNow);
    const transport = managerTransport({ denyOnPoll: true });
    registerPorts(crypto, transport, store);

    await expect(
      pairComputerFromQrPayload(JSON.stringify(offer), { computerName: 'Test Mac' }),
    ).rejects.toThrow('Pairing was denied or expired');
    await expect(loadPairedComputers()).resolves.toEqual([]);
  });

  it('rejects malformed and expired offers before any transport call', async () => {
    const transport = managerTransport();
    registerPorts(crypto, transport, store);

    await expect(
      pairComputerFromQrPayload('x'.repeat(4_097), { computerName: 'Test Mac' }),
    ).rejects.toBeInstanceOf(ComputerPairingOfferError);
    await expect(
      pairComputerFromQrPayload(JSON.stringify({ protocolVersion: 3 }), {
        computerName: 'Test Mac',
      }),
    ).rejects.toMatchObject({ code: 'pairing_version_incompatible' });

    const offer = manager.createOffer(TRANSPORT, clockNow);
    const expired: PairingOffer = { ...offer, expiresAt: clockNow - 10_000 };
    await expect(
      pairComputerFromQrPayload(JSON.stringify(expired), { computerName: 'Test Mac' }),
    ).rejects.toMatchObject({ code: 'pairing_code_expired' });
    expect(transport.posts).toHaveLength(0);
  });

  it('rejects an offer whose fingerprint does not match the bridge key', async () => {
    const offer = manager.createOffer(TRANSPORT, clockNow);
    const forged: PairingOffer = { ...offer, bridgeKeyFingerprint: 'Z'.repeat(43) };
    const transport = managerTransport();
    registerPorts(crypto, transport, store);

    await expect(
      pairComputerFromQrPayload(JSON.stringify(forged), { computerName: 'Test Mac' }),
    ).rejects.toThrow('The pairing code has an invalid bridge identity');
    expect(transport.posts).toHaveLength(0);
  });

  it('migrates the endpoint when re-pairing an already-paired bridge', async () => {
    const transport = managerTransport();
    registerPorts(crypto, transport, store);
    const seeded = await seedExistingPairing(ENDPOINT);
    const offer = manager.createOffer(NEW_TRANSPORT, clockNow);

    const summary = await pairComputerFromQrPayload(JSON.stringify(offer), {
      computerName: 'Unused',
    });

    // Migration verified the credential against the NEW endpoint, then saved.
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.path).toBe('/v1/request');
    expect(transport.posts[0]!.endpoint).toBe(NEW_ENDPOINT);

    const computers = await loadPairedComputers();
    expect(computers).toHaveLength(1);
    expect(computers[0]!.endpoint).toBe(NEW_ENDPOINT);
    expect(computers[0]!.deviceId).toBe(seeded.deviceId);
    expect(computers[0]!.bridgePublicKeySpki).toBe(bridgePublicKeySpki);
    expect(summary).toMatchObject({ bridgeId: BRIDGE_ID, transportKind: 'tailscale_vpn' });
  });

  it('re-pairs fresh when the stored credential was revoked bridge-side', async () => {
    const transport = managerTransport({
      requestResult: { status: 404, body: { error: 'not_found' } },
      approveOnPoll: 1,
    });
    registerPorts(crypto, transport, store);
    const seeded = await seedExistingPairing(ENDPOINT);
    const offer = manager.createOffer(NEW_TRANSPORT, clockNow);

    const summary = await pairComputerFromQrPayload(JSON.stringify(offer), {
      computerName: 'Test Mac',
    });

    // The revoked credential was dropped, a fresh ceremony ran, and the new
    // device replaced the old registration.
    const paths = transport.posts.map((post) => post.path);
    expect(paths[0]).toBe('/v1/request');
    expect(paths).toContain('/v1/pair/submit');
    expect(paths).toContain('/v1/pair/status');

    const computers = await loadPairedComputers();
    expect(computers).toHaveLength(1);
    expect(computers[0]!.deviceId).not.toBe(seeded.deviceId);
    expect(computers[0]!.endpoint).toBe(NEW_ENDPOINT);
    expect(summary.bridgeId).toBe(BRIDGE_ID);
    await expect(crypto.hasDeviceIdentity(seeded.credential.deviceKeyId)).resolves.toBe(false);
    expect(registryDevices.size).toBe(1);
  });
});
