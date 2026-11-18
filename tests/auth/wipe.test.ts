/**
 * §10.5 gate test — disconnect wipes legacy Cloud Keychain credentials.
 * Uses mocked secure-store.
 */

import { wipeLegacyCloudCredentials } from '../../src/auth/keychain';

// Mock expo-secure-store
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    setItemAsync: jest.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    getItemAsync: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    deleteItemAsync: jest.fn((key: string) => { store.delete(key); return Promise.resolve(); }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 2,
    _store: store,
  };
});

// Import the mocked module at the top level
import * as SecureStore from 'expo-secure-store';

const ORIGINAL_DEV = Reflect.get(globalThis, '__DEV__') as unknown;
const ORIGINAL_FIXTURE_ENV = process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES;

function restoreFixtureEnvironment() {
  if (ORIGINAL_DEV === undefined) {
    Reflect.deleteProperty(globalThis, '__DEV__');
  } else {
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      value: Boolean(ORIGINAL_DEV),
      writable: true,
    });
  }
  if (ORIGINAL_FIXTURE_ENV === undefined) {
    delete process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES;
  } else {
    process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES = ORIGINAL_FIXTURE_ENV;
  }
}

describe('disconnect wipe (§10.5 gate)', () => {
  it('removes legacy Cloud credentials without deleting paired-computer credentials', async () => {
    await SecureStore.setItemAsync('devin_api_key', 'cog_test123456789012');
    await SecureStore.setItemAsync('devin_org_id', 'org-test123456789012');
    await SecureStore.setItemAsync('attribution_user_id', 'user-123');
    await SecureStore.setItemAsync('auth_kind', 'service_user');
    await SecureStore.setItemAsync('paired_computers_v1', '[{"paired":true}]');

    await wipeLegacyCloudCredentials();
    await wipeLegacyCloudCredentials();
    expect(await SecureStore.getItemAsync('devin_api_key')).toBeNull();
    expect(await SecureStore.getItemAsync('devin_org_id')).toBeNull();
    expect(await SecureStore.getItemAsync('auth_kind')).toBeNull();
    expect(await SecureStore.getItemAsync('attribution_user_id')).toBeNull();
    expect(await SecureStore.getItemAsync('paired_computers_v1')).toBe('[{"paired":true}]');
  });

  it('skips secure-store cleanup in development screenshot fixture mode', async () => {
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      value: true,
      writable: true,
    });
    process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES = '1';
    jest.mocked(SecureStore.deleteItemAsync).mockClear();

    await wipeLegacyCloudCredentials();

    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    restoreFixtureEnvironment();
  });
});
