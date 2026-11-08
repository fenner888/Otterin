// SecretBlobStore over Electron safeStorage (PLAN §8).
//
// Each named secret is safeStorage-encrypted into its own file under
// userData/secrets (0600). The encryption key lives in the app's own
// Keychain item ("<productName> Safe Storage"), which third-party binaries
// cannot invoke without a user prompt.
//
// Bind-hazard: safeStorage must not be touched before the first
// BrowserWindow is ready — earlier use can grab the shared "Chromium Safe
// Storage" keychain item (Electron #34614). index.ts calls initSecrets()
// from the window's ready-to-show handler; every operation asserts that.
//
// Honest scope (PLAN §1): on unsigned builds this protects against other
// users and casual file snooping, not a hostile same-UID process.
//
// Electron is lazy-required so plain-Node jest runs can import this module
// (and tests can register their own SecretBlobStore) without the electron
// binary.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import type { SecretBlobStore } from '../../../client-core/src/ports';

export type SecretStoreErrorCode =
  | 'secrets_not_initialized'
  | 'secrets_unavailable'
  | 'credentials_unreadable';

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly code: SecretStoreErrorCode,
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

let secretsDir: string | null = null;

function electronApi(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

/**
 * Must be called after the first BrowserWindow signals ready-to-show (see
 * the bind hazard above). Idempotent.
 */
export function initSecrets(): void {
  const { app, safeStorage } = electronApi();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SecretStoreError(
      'OS keychain encryption is not available on this machine',
      'secrets_unavailable',
    );
  }
  const dir = join(app.getPath('userData'), 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  secretsDir = dir;
}

export function secretsReady(): boolean {
  return secretsDir !== null;
}

function fileForKey(key: string): string {
  if (secretsDir === null) {
    throw new SecretStoreError(
      'Secret store used before the app window was ready',
      'secrets_not_initialized',
    );
  }
  // Keys are stable store names (e.g. paired_computers_v1, device_keys_v1);
  // hashing keeps the filename safe for any future key shape.
  const name = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  return join(secretsDir, `${name}.bin`);
}

function assertEncryption(): typeof import('electron').safeStorage {
  const { safeStorage } = electronApi();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SecretStoreError(
      'OS keychain encryption is not available on this machine',
      'secrets_unavailable',
    );
  }
  return safeStorage;
}

export const macSecretBlobStore: SecretBlobStore = {
  async read(key: string): Promise<string | null> {
    const path = fileForKey(key);
    if (!existsSync(path)) {
      return null;
    }
    const safeStorage = assertEncryption();
    try {
      return safeStorage.decryptString(readFileSync(path));
    } catch {
      // The caller maps this to "credentials unreadable, pair again" — the
      // blob belongs to a different keychain item / OS user / corrupted file.
      throw new SecretStoreError('Stored credentials could not be decrypted', 'credentials_unreadable');
    }
  },

  async write(key: string, value: string): Promise<void> {
    const path = fileForKey(key);
    const safeStorage = assertEncryption();
    const encrypted = safeStorage.encryptString(value);
    const fd = openSync(path, 'w', 0o600);
    try {
      writeSync(fd, encrypted);
      // openSync mode only applies on creation — enforce on rewrites too.
      chmodSync(path, 0o600);
    } finally {
      closeSync(fd);
    }
  },

  async delete(key: string): Promise<void> {
    const path = fileForKey(key);
    rmSync(path, { force: true });
  },
};
