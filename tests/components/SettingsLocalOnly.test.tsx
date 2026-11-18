import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@theme/index', () => ({
  setThemePreference: jest.fn(),
  useThemePreference: () => 'system',
  useTheme: () => ({
    tokens: {
      textMid: { hex: 'mid' },
      textLow: { hex: 'low' },
      finished: { hex: 'finished' },
      brand: { hex: 'brand' },
      brandText: { hex: 'brand-text' },
      textAlwaysWhite: { hex: 'white' },
    },
  }),
}));
jest.mock('@auth/ConnectionContext', () => ({
  useConnections: () => ({
    computers: [],
    hasComputerConnection: false,
    connectionError: null,
    disconnectAll: jest.fn(),
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: jest.fn() }),
}));
jest.mock('@lib/localUserData', () => ({
  purgeUserScopedStorage: jest.fn(async () => undefined),
}));
jest.mock('@lib/confirm', () => ({ confirmAction: jest.fn() }));

import { confirmAction } from '@lib/confirm';
import SettingsScreen from '../../src/app/(main)/settings';

describe('Local-only Settings', () => {
  it('renders Local settings without removed Cloud sections', () => {
    const screen = render(<SettingsScreen />);

    for (const section of [
      'Connections',
      'Local devices',
      'Appearance',
      'Haptic feedback',
      'Refresh speed',
      'Privacy',
      'About',
    ]) {
      expect(screen.getByText(section)).toBeTruthy();
    }
    for (const removedSection of [
      'Connection mode',
      'Devin Cloud',
      'Integrations & MCP',
      'Default session tags',
      'Account',
      'Usage & limits',
      'Products',
      'Resources',
      'Polling',
    ]) {
      expect(screen.queryByText(removedSection)).toBeNull();
    }
    fireEvent.press(screen.getByLabelText('Fast refresh speed'));
    expect(
      screen.getByText(
        'Session lists check for paired computers every 15s. Open sessions update every 1s.',
      ),
    ).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Wipe all local data'));
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'This removes paired-computer keys and cached session data from this iPhone. Your local sessions are not affected.',
      }),
      expect.any(Function),
    );
  });
});
