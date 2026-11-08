// Copy of src/auth/pairedComputers.ts (see copy-source-sha.txt) with:
//  - `@lib/branding` replaced by the local branding facade (same store key)
//  - `./screenshotFixtures` imports and fixture-mode guards removed
import { z } from 'zod';

import { branding } from './branding';

import { deleteSecret, getSecret, storeSecret } from './keychain';
import {
  deleteAllDeviceIdentities,
  hasDeviceIdentity,
  isDeviceCryptoAvailable,
  isPinnedBridgeTransportAvailable,
} from './deviceSigning';

const base64UrlSchema = z
  .string()
  .min(32)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);

const bridgePermissionSchema = z.enum([
  'bridge:health',
  'session:metadata:read',
  'session:content:read',
  'session:prompt:send',
  'session:create',
]);

export const pairedComputerCredentialSchema = z
  .object({
    version: z.union([z.literal(2), z.literal(3)]),
    bridgeId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    computerName: z.string().trim().min(1).max(80),
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.username === '' &&
            url.password === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === '' &&
            url.port !== '' &&
            url.toString() === value
          );
        } catch {
          return false;
        }
      }, 'Paired computer endpoint must be a canonical HTTP or HTTPS origin with an explicit port'),
    transportSecurity: z.enum(['tailscale_wireguard', 'pinned_tls']).optional(),
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    bridgePublicKeySpki: base64UrlSchema.length(59),
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    deviceId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    deviceKeyId: z.string().uuid(),
    devicePublicKeySpki: base64UrlSchema.length(59),
    permissions: z.array(bridgePermissionSchema).max(bridgePermissionSchema.options.length),
    pairedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.permissions).size !== value.permissions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Permissions must be unique' });
    }
    const scheme = new URL(value.endpoint).protocol;
    const transportSecurity = value.transportSecurity ?? 'pinned_tls';
    if (
      (transportSecurity === 'tailscale_wireguard' && scheme !== 'http:') ||
      (transportSecurity === 'pinned_tls' && scheme !== 'https:')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Transport security mismatch' });
    }
  })
  .transform((value) => ({
    ...value,
    version: 3 as const,
    transportSecurity: value.transportSecurity ?? ('pinned_tls' as const),
  }));

const pairedComputerListSchema = z
  .array(pairedComputerCredentialSchema)
  .max(8)
  .superRefine((value, context) => {
    const bridgeIds = value.map((computer) => computer.bridgeId);
    const deviceIds = value.map((computer) => computer.deviceId);
    if (new Set(bridgeIds).size !== bridgeIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bridge IDs must be unique' });
    }
    if (new Set(deviceIds).size !== deviceIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Device IDs must be unique' });
    }
  });

export type PairedComputerCredential = z.infer<typeof pairedComputerCredentialSchema>;

export type ComputerTransportKind = 'local_network' | 'tailscale_vpn';

export function computerTransportKind(endpoint: string): ComputerTransportKind {
  const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname.endsWith('.ts.net')) return 'tailscale_vpn';
  if (hostname.startsWith('fd7a:115c:a1e0:')) return 'tailscale_vpn';
  const [first, second] = hostname.split('.').map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127
    ? 'tailscale_vpn'
    : 'local_network';
}

export function computerTransportLabel(kind: ComputerTransportKind): string {
  return kind === 'tailscale_vpn' ? 'Tailscale' : 'Unavailable';
}

export interface PairedComputerSummary {
  bridgeId: string;
  computerName: string;
  pairedAt: number;
  permissions: PairedComputerCredential['permissions'];
  transportKind: ComputerTransportKind;
}

export async function loadPairedComputers(): Promise<PairedComputerCredential[]> {
  const stored = await getSecret(branding.keychain.pairedComputers);
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error('Paired computer credentials are corrupted');
  }
  const result = pairedComputerListSchema.safeParse(parsed);
  if (!result.success) throw new Error('Paired computer credentials failed validation');
  if (
    result.data.some((computer) => computer.transportSecurity === 'tailscale_wireguard') &&
    !isDeviceCryptoAvailable()
  ) {
    throw new Error('Tailnet computer credentials require a current secure transport');
  }
  if (
    result.data.some((computer) => computer.transportSecurity === 'pinned_tls') &&
    !isPinnedBridgeTransportAvailable()
  ) {
    throw new Error('Pinned computer credentials require a current secure transport');
  }
  const keyAvailability = await Promise.all(
    result.data.map((computer) => hasDeviceIdentity(computer.deviceKeyId)),
  );
  if (keyAvailability.some((available) => !available)) {
    throw new Error('A paired computer signing identity is missing');
  }
  return result.data;
}

export async function loadPairedComputerSummaries(): Promise<PairedComputerSummary[]> {
  const computers = await loadPairedComputers();
  return computers
    .filter((computer) => computer.transportSecurity === 'tailscale_wireguard')
    .map(({ bridgeId, computerName, pairedAt, permissions, endpoint }) => ({
      bridgeId,
      computerName,
      pairedAt,
      permissions: [...permissions],
      transportKind: computerTransportKind(endpoint),
    }));
}

export async function storePairedComputers(input: unknown): Promise<void> {
  const computers = pairedComputerListSchema.parse(input);
  if (
    computers.some((computer) => computer.transportSecurity === 'tailscale_wireguard') &&
    !isDeviceCryptoAvailable()
  ) {
    throw new Error('Tailnet computer credentials require a current secure transport');
  }
  if (
    computers.some((computer) => computer.transportSecurity === 'pinned_tls') &&
    !isPinnedBridgeTransportAvailable()
  ) {
    throw new Error('Pinned computer credentials require a current secure transport');
  }
  const keyAvailability = await Promise.all(
    computers.map((computer) => hasDeviceIdentity(computer.deviceKeyId)),
  );
  if (keyAvailability.some((available) => !available)) {
    throw new Error('A paired computer signing identity is missing');
  }
  await storeSecret(branding.keychain.pairedComputers, JSON.stringify(computers));
}

export async function clearPairedComputers(): Promise<void> {
  const stored = await getSecret(branding.keychain.pairedComputers);
  if (isDeviceCryptoAvailable()) {
    await deleteAllDeviceIdentities();
  } else if (stored) {
    throw new Error('Native signing keys cannot be securely erased in this app build');
  }
  await deleteSecret(branding.keychain.pairedComputers);
}
