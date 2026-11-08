// DeviceCrypto implementation backed by node:crypto (PLAN §2, §8).
//
// Ed25519 keys are generated in-process. Private key PKCS8 DER is stored in
// the registered SecretBlobStore (safeStorage-encrypted on disk), keyed by
// keyId inside a single JSON vault blob. Key bytes never leave the main
// process — nothing here touches IPC, logs, or the renderer.
//
// Interop is pinned by PLAN §2: SPKI DER is RFC 8410 (44 B → base64url 59)
// and Ed25519 signatures are 64 B → base64url 86, matching both the iOS
// module and bridge/src/security.ts verification.

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto';

import { requireSecretStore, type DeviceCrypto } from '../../../client-core/src/ports';

const KEY_VAULT_BLOB = 'device_keys_v1';
const MAX_VAULT_KEYS = 64;

interface VaultEntry {
  /** PKCS8 DER, base64url. */
  pkcs8: string;
  /** SPKI DER, base64url — kept so the vault is self-describing. */
  spki: string;
}

type Vault = Record<string, VaultEntry>;

// Reads/writes to the vault are serialized so concurrent identity operations
// cannot interleave a read-modify-write cycle.
let vaultQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = vaultQueue.then(operation, operation);
  vaultQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readVault(): Promise<Vault> {
  const raw = await requireSecretStore().read(KEY_VAULT_BLOB);
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Vault;
  } catch {
    return {};
  }
}

async function writeVault(vault: Vault): Promise<void> {
  await requireSecretStore().write(KEY_VAULT_BLOB, JSON.stringify(vault));
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function privateKeyFromEntry(entry: VaultEntry): KeyObject {
  return createPrivateKey({
    key: Buffer.from(entry.pkcs8, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
}

async function vaultEntry(keyId: string): Promise<VaultEntry> {
  const vault = await readVault();
  const entry = vault[keyId];
  if (!entry) {
    throw new Error('Device signing identity is missing');
  }
  return entry;
}

export const nodeDeviceCrypto: DeviceCrypto = {
  isDeviceCryptoAvailable(): boolean {
    return true;
  },

  isPinnedBridgeTransportAvailable(): boolean {
    // v1 is tailnet-only per PLAN §8; pinned_tls credentials are refused at
    // open and no pinned transport ships.
    return false;
  },

  async createDeviceIdentity(): Promise<{ keyId: string; publicKeySpki: string }> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
    const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' });
    const keyId = randomUUID();
    const publicKeySpki = toBase64Url(spkiDer);
    // Encode before enqueueing — the queued write runs after awaits, so the
    // DER buffer can be wiped here without racing it.
    const pkcs8 = toBase64Url(pkcs8Der);
    pkcs8Der.fill(0);
    await enqueue(async () => {
      const vault = await readVault();
      if (Object.keys(vault).length >= MAX_VAULT_KEYS) {
        throw new Error('Device signing key vault is full');
      }
      vault[keyId] = { pkcs8, spki: publicKeySpki };
      await writeVault(vault);
    });
    return { keyId, publicKeySpki };
  },

  async hasDeviceIdentity(keyId: string): Promise<boolean> {
    const vault = await readVault();
    return vault[keyId] !== undefined;
  },

  async deleteDeviceIdentity(keyId: string): Promise<void> {
    await enqueue(async () => {
      const vault = await readVault();
      if (vault[keyId] !== undefined) {
        delete vault[keyId];
        await writeVault(vault);
      }
    });
  },

  async deleteAllDeviceIdentities(): Promise<void> {
    await enqueue(async () => {
      await requireSecretStore().delete(KEY_VAULT_BLOB);
    });
  },

  async sign(keyId: string, message: string): Promise<string> {
    const entry = await vaultEntry(keyId);
    const key = privateKeyFromEntry(entry);
    return toBase64Url(ed25519Sign(null, Buffer.from(message, 'utf8'), key));
  },

  async verify(publicKeySpki: string, message: string, signature: string): Promise<boolean> {
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKeySpki, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      return ed25519Verify(
        null,
        Buffer.from(message, 'utf8'),
        key,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  },

  async hmacSha256(secret: string, message: string): Promise<string> {
    // `secret` is the base64url pairingSecret — decode before keying (the HMAC
    // key is the raw 32 bytes, not the encoded string).
    const key = Buffer.from(secret, 'base64url');
    const digest = createHmac('sha256', key).update(message, 'utf8').digest();
    key.fill(0);
    return toBase64Url(digest);
  },

  async fingerprintPublicKeySpki(publicKeySpki: string): Promise<string> {
    // sha256 over the DER bytes (not the base64url string), matching the
    // bridgeKeyFingerprint construction in bridge/src/pairing.ts.
    const digest = createHash('sha256')
      .update(Buffer.from(publicKeySpki, 'base64url'))
      .digest();
    return toBase64Url(digest);
  },

  async createRequestIdentity(): Promise<{ requestId: string; nonce: string }> {
    return {
      requestId: randomUUID(),
      nonce: toBase64Url(randomBytes(24)),
    };
  },
};
