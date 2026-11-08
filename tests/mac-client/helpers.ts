// Shared test ports for client-core: a node:crypto-backed DeviceCrypto that
// mirrors what mac-client's crypto.node.ts will implement, an in-memory
// SecretBlobStore, and a recording BridgeTransport.
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

import {
  registerBridgeTransport,
  registerDeviceCrypto,
  registerSecretStore,
  type BridgePostResult,
  type BridgeTransport,
  type DeviceCrypto,
  type SecretBlobStore,
} from '../../client-core/src/ports';
import {
  loadPairedComputers,
  storePairedComputers,
  type PairedComputerCredential,
} from '../../client-core/src/pairedComputers';

export class NodeDeviceCrypto implements DeviceCrypto {
  private readonly privateKeys = new Map<string, KeyObject>();

  isDeviceCryptoAvailable(): boolean {
    return true;
  }

  isPinnedBridgeTransportAvailable(): boolean {
    return true;
  }

  async createDeviceIdentity(): Promise<{ keyId: string; publicKeySpki: string }> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyId = randomUUID();
    this.privateKeys.set(keyId, privateKey);
    return {
      keyId,
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    };
  }

  /** Registers an externally generated key under a chosen keyId. */
  importIdentity(keyId: string, privateKey: KeyObject): void {
    this.privateKeys.set(keyId, privateKey);
  }

  async hasDeviceIdentity(keyId: string): Promise<boolean> {
    return this.privateKeys.has(keyId);
  }

  async deleteDeviceIdentity(keyId: string): Promise<void> {
    this.privateKeys.delete(keyId);
  }

  async deleteAllDeviceIdentities(): Promise<void> {
    this.privateKeys.clear();
  }

  async sign(keyId: string, message: string): Promise<string> {
    const key = this.privateKeys.get(keyId);
    if (!key) throw new Error(`Unknown device key ${keyId}`);
    return nodeSign(null, Buffer.from(message, 'utf8'), key).toString('base64url');
  }

  async verify(publicKeySpki: string, message: string, signature: string): Promise<boolean> {
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKeySpki, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      return nodeVerify(
        null,
        Buffer.from(message, 'utf8'),
        key,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  }

  async hmacSha256(secret: string, message: string): Promise<string> {
    const secretBytes = Buffer.from(secret, 'base64url');
    try {
      return createHmac('sha256', secretBytes).update(message, 'utf8').digest('base64url');
    } finally {
      secretBytes.fill(0);
    }
  }

  async fingerprintPublicKeySpki(publicKeySpki: string): Promise<string> {
    return createHash('sha256')
      .update(Buffer.from(publicKeySpki, 'base64url'))
      .digest('base64url');
  }

  async createRequestIdentity(): Promise<{ requestId: string; nonce: string }> {
    return { requestId: randomUUID(), nonce: randomBytes(24).toString('base64url') };
  }
}

export class InMemorySecretStore implements SecretBlobStore {
  readonly entries = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface RecordedPost {
  endpoint: string;
  path: string;
  body: unknown;
}

export type TransportHandler = (
  path: string,
  body: unknown,
  post: RecordedPost,
) => BridgePostResult | Promise<BridgePostResult>;

export class RecordingTransport implements BridgeTransport {
  readonly posts: RecordedPost[] = [];

  constructor(private readonly handler: TransportHandler) {}

  async postTailnetBridgeJson(
    endpoint: string,
    path: string,
    body: unknown,
  ): Promise<BridgePostResult> {
    const post: RecordedPost = { endpoint, path, body };
    this.posts.push(post);
    return this.handler(path, body, post);
  }

  async postPinnedBridgeJson(
    endpoint: string,
    path: string,
    _certificateFingerprint: string,
    body: unknown,
  ): Promise<BridgePostResult> {
    const post: RecordedPost = { endpoint, path, body };
    this.posts.push(post);
    return this.handler(path, body, post);
  }

  /** Bodies POSTed to /v1/request, in order. */
  envelopes(): Array<Record<string, unknown>> {
    return this.posts
      .filter((post) => post.path === '/v1/request')
      .map((post) => post.body as Record<string, unknown>);
  }
}

export function registerPorts(
  crypto: NodeDeviceCrypto,
  transport: BridgeTransport,
  store: InMemorySecretStore,
): void {
  registerDeviceCrypto(crypto);
  registerBridgeTransport(transport);
  registerSecretStore(store);
}

export const TEST_BRIDGE_ID = 'bridge_1234567890';
export const TEST_ENDPOINT = 'http://100.64.1.5:45831/';
export const ALL_GRANTS: PairedComputerCredential['permissions'] = [
  'bridge:health',
  'session:metadata:read',
  'session:content:read',
  'session:prompt:send',
  'session:create',
];

/** Seeds a v3 tailnet credential + registered signing key into the test ports. */
export async function seedPairedComputer(input: {
  crypto: NodeDeviceCrypto;
  bridgeId?: string;
  endpoint?: string;
  permissions?: PairedComputerCredential['permissions'];
  computerName?: string;
  bridgePublicKeySpki?: string;
  bridgeKeyFingerprint?: string;
  tlsCertificateFingerprint?: string;
}): Promise<{
  credential: PairedComputerCredential;
  deviceId: string;
  publicKeySpki: string;
}> {
  const identity = await input.crypto.createDeviceIdentity();
  const deviceId = `device_${identity.keyId.replaceAll('-', '')}`;
  const credential = {
    version: 3 as const,
    bridgeId: input.bridgeId ?? TEST_BRIDGE_ID,
    computerName: input.computerName ?? 'Test Mac',
    endpoint: input.endpoint ?? TEST_ENDPOINT,
    transportSecurity: 'tailscale_wireguard' as const,
    tlsCertificateFingerprint: input.tlsCertificateFingerprint ?? 'T'.repeat(43),
    bridgePublicKeySpki: input.bridgePublicKeySpki ?? 'B'.repeat(59),
    bridgeKeyFingerprint: input.bridgeKeyFingerprint ?? 'K'.repeat(43),
    deviceId,
    deviceKeyId: identity.keyId,
    devicePublicKeySpki: identity.publicKeySpki,
    permissions: input.permissions ?? [...ALL_GRANTS],
    pairedAt: 1_800_000_000_000,
  };
  const existing = await loadPairedComputers().catch(() => [] as PairedComputerCredential[]);
  await storePairedComputers([...existing, credential]);
  return { credential, deviceId, publicKeySpki: identity.publicKeySpki };
}
