// Facade matching src/auth/keychain.ts's export surface. Delegates to the
// registered SecretBlobStore port.
import { requireSecretStore } from './ports';

export function getSecret(key: string): Promise<string | null> {
  return requireSecretStore().read(key);
}

export function storeSecret(key: string, value: string): Promise<void> {
  return requireSecretStore().write(key, value);
}

export function deleteSecret(key: string): Promise<void> {
  return requireSecretStore().delete(key);
}
