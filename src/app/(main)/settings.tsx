import { useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useConnections } from '@auth/ConnectionContext';
import { computerTransportLabel } from '@auth/pairedComputers';
import { branding } from '@lib/branding';
import { confirmAction } from '@lib/confirm';
import { purgeUserScopedStorage } from '@lib/localUserData';
import { useAppPreferences } from '@store/preferences';
import { formatRefreshInterval, localRefreshIntervals } from '@lib/polling';
import {
  setThemePreference,
  useThemePreference,
  useTheme,
  type ThemePreference,
} from '@theme/index';

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { computers, hasComputerConnection, connectionError, disconnectAll } = useConnections();
  const queryClient = useQueryClient();
  const { tokens } = useTheme();
  const themePreference = useThemePreference();
  const hapticsEnabled = useAppPreferences((state) => state.hapticsEnabled);
  const setHaptics = useAppPreferences((state) => state.setHaptics);
  const pollingMode = useAppPreferences((state) => state.pollingMode);
  const setPollingMode = useAppPreferences((state) => state.setPollingMode);
  const refreshIntervals = localRefreshIntervals(pollingMode);
  const sessionListInterval = formatRefreshInterval(refreshIntervals.sessionList);
  const activityInterval = formatRefreshInterval(refreshIntervals.activity);
  const [wipeError, setWipeError] = useState<string | null>(null);

  function handleWipe() {
    confirmAction(
      {
        title: 'Wipe local data?',
        message:
          'This removes paired-computer keys and cached session data from this iPhone. Your local sessions are not affected.',
        confirmLabel: 'Wipe all',
        destructive: true,
      },
      async () => {
        setWipeError(null);
        try {
          await disconnectAll();
          await purgeUserScopedStorage();
          queryClient.clear();
          router.replace('/(onboarding)');
        } catch {
          setWipeError('The secure wipe did not complete. Please try again.');
        }
      },
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-surface0" edges={['top']}>
      <View className="flex-row items-center px-4 pt-2 pb-4">
        <Pressable
          className="w-9 h-9 rounded-full bg-tint-secondary items-center justify-center mr-3"
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={18} color={tokens.textMid.hex} />
        </Pressable>
        <Text className="text-text-hi text-text20">Settings</Text>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-10">
        <Text className="text-text-low text-text12 font-medium uppercase mb-2">Connections</Text>
        <View className="bg-surface1 rounded-card border border-border-subtle overflow-hidden mb-6">
          <Pressable
            className="flex-row items-center px-4 py-3"
            onPress={() => router.push('/(main)/computer')}
            accessibilityRole="button"
            accessibilityLabel="Local devices"
          >
            <View className="w-8 h-8 rounded-button bg-tint-blue items-center justify-center mr-3">
              <Ionicons
                name="desktop-outline"
                size={16}
                color={hasComputerConnection ? tokens.finished.hex : tokens.textLow.hex}
              />
            </View>
            <View className="flex-1">
              <Text className="text-text-hi text-text14">
                {computers.length === 1 ? computers[0]?.computerName : 'Local devices'}
              </Text>
              <Text className="text-text-low text-text12 mt-0.5">
                {hasComputerConnection
                  ? `${computers.length} paired ${computers.length === 1 ? `computer · ${computerTransportLabel(computers[0]!.transportKind)}` : 'computers'}`
                  : 'No paired computers'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={tokens.textLow.hex} />
          </Pressable>
          {connectionError && (
            <View className="border-t border-border-subtle px-4 py-3">
              <Text className="text-failed text-text12">{connectionError}</Text>
            </View>
          )}
        </View>

        <Text className="text-text-low text-text12 font-medium uppercase mb-2">Appearance</Text>
        <View className="bg-surface1 rounded-card border border-border-subtle overflow-hidden mb-6">
          <View className="px-4 py-3">
            <Text className="text-text-hi text-text14 mb-2">Theme</Text>
            <View className="flex-row bg-tint-secondary rounded-button p-1">
              {THEME_OPTIONS.map(({ key, label }) => (
                <Pressable
                  key={key}
                  className={`flex-1 rounded-button py-2 ${themePreference === key ? 'bg-surface2' : ''}`}
                  onPress={() => setThemePreference(key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} theme`}
                  accessibilityState={{ selected: themePreference === key }}
                >
                  <Text
                    className={`text-center text-text13 ${themePreference === key ? 'text-text-hi font-medium' : 'text-text-mid'}`}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable
            className="flex-row items-center border-t border-border-subtle px-4 py-3"
            onPress={() => setHaptics(!hapticsEnabled)}
            accessibilityRole="switch"
            accessibilityState={{ checked: hapticsEnabled }}
            accessibilityLabel="Haptic feedback"
          >
            <View className="flex-1">
              <Text className="text-text-hi text-text14">Haptic feedback</Text>
              <Text className="text-text-low text-text12 mt-0.5">
                Vibrate on taps and status changes.
              </Text>
            </View>
            <View
              className={`w-12 h-7 rounded-chip p-0.5 ${hapticsEnabled ? 'bg-brand' : 'bg-tint-primary'}`}
            >
              <View
                className={`w-6 h-6 rounded-chip bg-surface2 ${hapticsEnabled ? 'ml-auto' : ''}`}
              />
            </View>
          </Pressable>
          <View className="border-t border-border-subtle px-4 py-3">
            <Text className="text-text-hi text-text14 mb-2">Refresh speed</Text>
            <View className="flex-row bg-tint-secondary rounded-button p-1">
              {([
                ['battery_saver', 'Battery saver'],
                ['balanced', 'Balanced'],
                ['fast', 'Fast'],
              ] as const).map(([mode, label]) => (
                <Pressable
                  key={mode}
                  className={`min-h-11 flex-1 items-center justify-center rounded-button px-1 ${pollingMode === mode ? 'bg-surface2' : ''}`}
                  onPress={() => setPollingMode(mode)}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} refresh speed`}
                  accessibilityState={{ selected: pollingMode === mode }}
                >
                  <Text
                    className={`text-center text-text12 ${pollingMode === mode ? 'text-text-hi font-medium' : 'text-text-mid'}`}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text className="mt-2 text-text-low text-text12">
              Session lists check for paired computers every {sessionListInterval}. Open sessions
              update every {activityInterval}.
            </Text>
          </View>
        </View>

        <Text className="text-text-low text-text12 font-medium uppercase mb-2">Privacy</Text>
        <View className="bg-surface1 rounded-card border border-border-subtle overflow-hidden mb-6">
          <Pressable
            className="flex-row items-center px-4 py-3"
            onPress={() => router.push('/(main)/privacy')}
            accessibilityRole="button"
            accessibilityLabel="What data leaves your device"
          >
            <View className="w-8 h-8 rounded-button bg-tint-blue items-center justify-center mr-3">
              <Ionicons name="shield-checkmark-outline" size={15} color={tokens.brandText.hex} />
            </View>
            <View className="flex-1">
              <Text className="text-text-hi text-text14">What data leaves your device?</Text>
              <Text className="text-text-low text-text12 mt-0.5">
                Local sessions, storage, and on-device voice.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={tokens.textLow.hex} />
          </Pressable>
        </View>

        <Text className="text-text-low text-text12 font-medium uppercase mb-2">About</Text>
        <View className="bg-surface1 rounded-card border border-border-subtle px-4 py-3 mb-6">
          <Text className="text-text-hi text-text14 mb-1">{branding.name}</Text>
          <Text className="text-text-mid text-text13 mb-1">{branding.subtitle}</Text>
          <Text className="text-text-low text-text12 mb-3">
            Version {Constants.expoConfig?.version ?? '0.1.0'}
          </Text>
          <Text className="text-text-low text-text12 leading-4 mb-3">{branding.disclaimer}</Text>
          <View className="flex-row flex-wrap">
            <Pressable className="mr-4 mb-2" onPress={() => Linking.openURL(branding.links.docs)}>
              <Text className="text-link text-text13">Devin docs →</Text>
            </Pressable>
            <Pressable className="mr-4 mb-2" onPress={() => Linking.openURL(branding.links.status)}>
              <Text className="text-link text-text13">Devin status →</Text>
            </Pressable>
            <Pressable
              className="mb-2"
              onPress={() => Linking.openURL('https://github.com/fenner888/Otterin')}
              accessibilityRole="link"
              accessibilityLabel="Open-source licenses"
            >
              <Text className="text-link text-text13">Licenses →</Text>
            </Pressable>
          </View>
        </View>

        {wipeError && (
          <View className="bg-tint-red rounded-card px-4 py-3 mb-3">
            <Text className="text-failed text-text12">{wipeError}</Text>
          </View>
        )}
        <Pressable
          className="flex-row items-center justify-center bg-destructive rounded-button px-buttonPrimaryX py-buttonPrimaryY mb-8"
          onPress={handleWipe}
          accessibilityRole="button"
          accessibilityLabel="Wipe all local data"
        >
          <Ionicons name="trash-outline" size={16} color={tokens.textAlwaysWhite.hex} />
          <Text className="text-text-always-white text-text14 font-medium ml-2">
            Wipe all local data
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
