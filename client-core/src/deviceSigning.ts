// Facade matching src/auth/deviceSigning.ts's export surface so copied
// protocol code imports unchanged. Delegates to the registered ports.
import {
  requireBridgeTransport,
  requireDeviceCrypto,
  type BridgePostResult,
} from './ports';

export function isDeviceCryptoAvailable(): boolean {
  return requireDeviceCrypto().isDeviceCryptoAvailable();
}

export function isPinnedBridgeTransportAvailable(): boolean {
  return requireDeviceCrypto().isPinnedBridgeTransportAvailable();
}

export function createDeviceIdentity(): Promise<{ keyId: string; publicKeySpki: string }> {
  return requireDeviceCrypto().createDeviceIdentity();
}

export function hasDeviceIdentity(keyId: string): Promise<boolean> {
  return requireDeviceCrypto().hasDeviceIdentity(keyId);
}

export function deleteDeviceIdentity(keyId: string): Promise<void> {
  return requireDeviceCrypto().deleteDeviceIdentity(keyId);
}

export function deleteAllDeviceIdentities(): Promise<void> {
  return requireDeviceCrypto().deleteAllDeviceIdentities();
}

export function sign(keyId: string, message: string): Promise<string> {
  return requireDeviceCrypto().sign(keyId, message);
}

export function verify(
  publicKeySpki: string,
  message: string,
  signature: string,
): Promise<boolean> {
  return requireDeviceCrypto().verify(publicKeySpki, message, signature);
}

// Alias kept for callers that used the pre-copy facade name.
export function verifySignature(
  publicKeySpki: string,
  message: string,
  signature: string,
): Promise<boolean> {
  return verify(publicKeySpki, message, signature);
}

export function hmacSha256(secret: string, message: string): Promise<string> {
  return requireDeviceCrypto().hmacSha256(secret, message);
}

export function fingerprintPublicKeySpki(publicKeySpki: string): Promise<string> {
  return requireDeviceCrypto().fingerprintPublicKeySpki(publicKeySpki);
}

export function createRequestIdentity(): Promise<{ requestId: string; nonce: string }> {
  return requireDeviceCrypto().createRequestIdentity();
}

export function postTailnetBridgeJson(
  endpoint: string,
  path: string,
  body: unknown,
): Promise<BridgePostResult> {
  return requireBridgeTransport().postTailnetBridgeJson(endpoint, path, body);
}

export function postPinnedBridgeJson(
  endpoint: string,
  path: string,
  certificateFingerprint: string,
  body: unknown,
): Promise<BridgePostResult> {
  return requireBridgeTransport().postPinnedBridgeJson(endpoint, path, certificateFingerprint, body);
}
