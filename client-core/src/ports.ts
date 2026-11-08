// Platform ports for client-core. The copied protocol code calls the
// facades in deviceSigning.ts / keychain.ts, which delegate to the
// implementations registered here. Platform packages (mac-client) must
// register their adapters before touching any protocol entry point.

export interface DeviceCrypto {
  isDeviceCryptoAvailable(): boolean;
  isPinnedBridgeTransportAvailable(): boolean;
  createDeviceIdentity(): Promise<{ keyId: string; publicKeySpki: string }>;
  hasDeviceIdentity(keyId: string): Promise<boolean>;
  deleteDeviceIdentity(keyId: string): Promise<void>;
  deleteAllDeviceIdentities(): Promise<void>;
  /** Ed25519 signature over the UTF-8 message, base64url (86 chars). */
  sign(keyId: string, message: string): Promise<string>;
  verify(publicKeySpki: string, message: string, signature: string): Promise<boolean>;
  /** HMAC-SHA256 where `secret` is the base64url pairingSecret; decode it
   *  before keying the HMAC. Returns base64url (43 chars). */
  hmacSha256(secret: string, message: string): Promise<string>;
  /** base64url(SHA-256 of the SPKI DER) — 43 chars. */
  fingerprintPublicKeySpki(publicKeySpki: string): Promise<string>;
  createRequestIdentity(): Promise<{ requestId: string; nonce: string }>;
}

export interface BridgePostResult {
  status: number;
  body: unknown;
}

export interface BridgeTransport {
  postTailnetBridgeJson(endpoint: string, path: string, body: unknown): Promise<BridgePostResult>;
  postPinnedBridgeJson(endpoint: string, path: string, certificateFingerprint: string, body: unknown): Promise<BridgePostResult>;
}

/** Keyed secret blob store — platform adapter hides encryption. */
export interface SecretBlobStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

let deviceCrypto: DeviceCrypto | null = null;
let bridgeTransport: BridgeTransport | null = null;
let secretStore: SecretBlobStore | null = null;

export function registerDeviceCrypto(impl: DeviceCrypto): void {
  deviceCrypto = impl;
}

export function registerBridgeTransport(impl: BridgeTransport): void {
  bridgeTransport = impl;
}

export function registerSecretStore(impl: SecretBlobStore): void {
  secretStore = impl;
}

export function requireDeviceCrypto(): DeviceCrypto {
  if (!deviceCrypto) {
    throw new Error('DeviceCrypto port not registered');
  }
  return deviceCrypto;
}

export function requireBridgeTransport(): BridgeTransport {
  if (!bridgeTransport) {
    throw new Error('BridgeTransport port not registered');
  }
  return bridgeTransport;
}

export function requireSecretStore(): SecretBlobStore {
  if (!secretStore) {
    throw new Error('SecretBlobStore port not registered');
  }
  return secretStore;
}
