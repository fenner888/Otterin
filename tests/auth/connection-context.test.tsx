import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

jest.mock('../../src/auth/keychain', () => ({
  wipeLegacyCloudCredentials: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/lib/legacyCloudCache', () => ({
  deleteLegacyCloudCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/auth/pairedComputers', () => ({
  clearPairedComputers: jest.fn().mockResolvedValue(undefined),
  loadPairedComputerSummaries: jest.fn().mockResolvedValue([]),
}));

import { ConnectionProvider, useConnections } from '../../src/auth/ConnectionContext';
import { wipeLegacyCloudCredentials } from '../../src/auth/keychain';
import { deleteLegacyCloudCache } from '../../src/lib/legacyCloudCache';
import {
  clearPairedComputers,
  loadPairedComputerSummaries,
  type PairedComputerSummary,
} from '../../src/auth/pairedComputers';

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

function ConnectionProbe() {
  const { isConfigured, isLoading, disconnectAll } = useConnections();
  return (
    <View>
      <Text testID="configured">{String(isConfigured)}</Text>
      <Text testID="loading">{String(isLoading)}</Text>
      <Pressable testID="disconnect" onPress={disconnectAll}>
        <Text>Disconnect</Text>
      </Pressable>
    </View>
  );
}

describe('ConnectionProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(wipeLegacyCloudCredentials).mockResolvedValue(undefined);
    jest.mocked(deleteLegacyCloudCache).mockResolvedValue(undefined);
    jest.mocked(clearPairedComputers).mockResolvedValue(undefined);
    jest.mocked(loadPairedComputerSummaries).mockResolvedValue([]);
  });

  it('wipes legacy credentials and cache on launch and disconnect', async () => {
    const screen = render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').props.children).toBe('false'));
    expect(screen.getByTestId('configured').props.children).toBe('false');
    expect(wipeLegacyCloudCredentials).toHaveBeenCalledTimes(1);
    expect(deleteLegacyCloudCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('disconnect'));
    });

    await waitFor(() => expect(clearPairedComputers).toHaveBeenCalledTimes(1));
    expect(wipeLegacyCloudCredentials).toHaveBeenCalledTimes(2);
    expect(deleteLegacyCloudCache).toHaveBeenCalledTimes(2);
  });

  it('reports an incomplete wipe when the legacy cache cannot be deleted', async () => {
    let disconnectError: unknown;
    function DisconnectProbe() {
      const { isLoading, disconnectAll } = useConnections();
      return (
        <View>
          <Text testID="loading">{String(isLoading)}</Text>
          <Pressable
            testID="disconnect"
            onPress={() => disconnectAll().catch((error: unknown) => (disconnectError = error))}
          >
            <Text>Disconnect</Text>
          </Pressable>
        </View>
      );
    }
    const screen = render(
      <ConnectionProvider>
        <DisconnectProbe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading').props.children).toBe('false'));
    jest.mocked(deleteLegacyCloudCache).mockRejectedValueOnce(new Error('locked'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('disconnect'));
    });

    await waitFor(() => expect(disconnectError).toEqual(new Error('Secure connection wipe did not complete')));
  });

  it('derives isConfigured from the paired-computer list', async () => {
    const emptyScreen = render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(emptyScreen.getByTestId('configured').props.children).toBe('false'));
    emptyScreen.unmount();

    jest.mocked(loadPairedComputerSummaries).mockResolvedValue([
      {
        bridgeId: 'bridge-1',
        computerName: 'My Mac',
        pairedAt: 0,
        permissions: [],
        transportKind: 'local_network',
      } satisfies PairedComputerSummary,
    ]);
    const pairedScreen = render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(pairedScreen.getByTestId('configured').props.children).toBe('true'));
  });

  it('opens with the fixture paired Mac after the launch refresh', async () => {
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      value: true,
      writable: true,
    });
    process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES = '1';
    jest.mocked(loadPairedComputerSummaries).mockResolvedValue([
      {
        bridgeId: 'fixture_studio_mac_0001',
        computerName: 'Studio Mac',
        pairedAt: 0,
        permissions: ['bridge:health', 'session:create'],
        transportKind: 'tailscale_vpn',
      },
    ]);

    const screen = render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').props.children).toBe('false'));
    expect(screen.getByTestId('configured').props.children).toBe('true');
    expect(wipeLegacyCloudCredentials).toHaveBeenCalledTimes(1);
    restoreFixtureEnvironment();
  });
});
