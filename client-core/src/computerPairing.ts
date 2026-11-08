// Copy of src/auth/computerPairing.ts (see copy-source-sha.txt) with two
// deliberate deviations:
//  - default device name "Otterin iPhone" -> "Otterin (Mac)" (PLAN §13)
//  - the approval poll loop tolerates transient transport errors inside the
//    expiry window instead of failing on the first one; a Connector restart
//    mid-approval should not kill the ceremony (PLAN §3.3 step 3). Protocol
//    failures (bad status, schema mismatch, receipt mismatch) stay fatal.
import { z } from 'zod';

import { canonicalJson } from './canonicalJson';
import { ComputerBridgeError, verifyComputerBridgeCredential } from './computerBridge';
import {
  createDeviceIdentity,
  deleteDeviceIdentity,
  fingerprintPublicKeySpki,
  hmacSha256,
  postPinnedBridgeJson,
  postTailnetBridgeJson,
  verify,
} from './deviceSigning';
import {
  computerTransportKind,
  loadPairedComputers,
  pairedComputerCredentialSchema,
  storePairedComputers,
  type PairedComputerCredential,
  type PairedComputerSummary,
} from './pairedComputers';

const PROTOCOL_VERSION = 2 as const;
const MAXIMUM_QR_BYTES = 4_096;
const MAXIMUM_PAIRING_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const base64UrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/);
const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      }),
    'Device name contains control characters',
  );
const bridgeEndpointSchema = z
  .string()
  .url()
  .max(2_048)
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
  }, 'Bridge endpoint must be a canonical HTTP or HTTPS origin with an explicit port');
const transportSecuritySchema = z.enum(['tailscale_wireguard', 'pinned_tls']);

function isTailscaleHttpEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  const [first, second] = url.hostname.split('.').map(Number);
  return (
    url.protocol === 'http:' &&
    first === 100 &&
    second !== undefined &&
    second >= 64 &&
    second <= 127
  );
}
const bridgePermissionSchema = z.enum([
  'bridge:health',
  'session:metadata:read',
  'session:content:read',
  'session:prompt:send',
  'session:create',
]);

export const computerPairingOfferSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    bridgePublicKeySpki: base64UrlSchema.length(59),
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    pairingId: opaqueIdSchema,
    pairingSecret: base64UrlSchema.length(43),
    expiresAt: z.number().int().positive(),
    computerName: deviceNameSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.transportSecurity === 'tailscale_wireguard'
        ? isTailscaleHttpEndpoint(value.bridgeEndpoint)
        : new URL(value.bridgeEndpoint).protocol === 'https:';
    if (!valid) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Transport security mismatch' });
    }
  });

const unsignedPairingRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    pairingId: opaqueIdSchema,
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    deviceId: opaqueIdSchema,
    deviceName: deviceNameSchema,
    devicePublicKeySpki: base64UrlSchema.length(59),
  })
  .strict();

const pendingSubmissionSchema = z
  .object({
    status: z.literal('pending'),
    pollToken: base64UrlSchema.length(43),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const pendingStatusSchema = z
  .object({
    status: z.literal('pending'),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const pairingReceiptSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    deviceId: opaqueIdSchema,
    pairedAt: z.number().int().nonnegative(),
    permissions: z.array(bridgePermissionSchema).max(bridgePermissionSchema.options.length),
    signature: base64UrlSchema.length(86),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.permissions).size !== value.permissions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Permissions must be unique' });
    }
  });

const approvedStatusSchema = z
  .object({
    status: z.literal('approved'),
    receipt: pairingReceiptSchema,
  })
  .strict();

export type ComputerPairingOffer = z.infer<typeof computerPairingOfferSchema>;
export type ComputerPairingStatus =
  | 'validating'
  | 'checking_bridge_identity'
  | 'loading_existing_pairing'
  | 'creating_device_identity'
  | 'preparing_secure_request'
  | 'submitting'
  | 'waiting_for_approval'
  | 'saving'
  | 'complete';

export interface PairComputerOptions {
  computerName: string;
  useConnectorComputerName?: boolean;
  deviceName?: string;
  signal?: AbortSignal;
  onStatus?: (status: ComputerPairingStatus) => void;
}

interface PairingRuntime {
  now(): number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const defaultRuntime: PairingRuntime = {
  now: Date.now,
  wait: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Local pairing was cancelled'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('Local pairing was cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    }),
};

let runtimeOverride: PairingRuntime | undefined;
let pairingInProgress = false;

function runtime(): PairingRuntime {
  return runtimeOverride ?? defaultRuntime;
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Local pairing was cancelled');
}

function notify(options: PairComputerOptions, status: ComputerPairingStatus): void {
  try {
    options.onStatus?.(status);
  } catch {
    // A presentation callback cannot change pairing security or persistence state.
  }
}

export class ComputerPairingOfferError extends Error {
  constructor(
    readonly code: 'pairing_code_invalid' | 'pairing_version_incompatible' | 'pairing_code_expired',
  ) {
    super(
      code === 'pairing_code_expired'
        ? 'The pairing code has expired or has an invalid clock'
        : code === 'pairing_version_incompatible'
          ? 'The pairing code requires compatible Otterin and Otterin Connector versions'
          : 'The pairing code is invalid',
    );
  }
}

function parseOffer(payload: string, now: number): ComputerPairingOffer {
  if (payload.length === 0 || payload.length > MAXIMUM_QR_BYTES) {
    throw new ComputerPairingOfferError('pairing_code_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ComputerPairingOfferError('pairing_code_invalid');
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'protocolVersion' in parsed &&
    typeof parsed.protocolVersion === 'number' &&
    parsed.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new ComputerPairingOfferError('pairing_version_incompatible');
  }
  const result = computerPairingOfferSchema.safeParse(parsed);
  if (!result.success) throw new ComputerPairingOfferError('pairing_code_invalid');
  const offer = result.data;
  if (offer.expiresAt <= now - 5_000 || offer.expiresAt > now + MAXIMUM_PAIRING_WINDOW_MS) {
    throw new ComputerPairingOfferError('pairing_code_expired');
  }
  return offer;
}

function validatePendingExpiry(expiresAt: number, now: number): void {
  if (expiresAt <= now || expiresAt > now + MAXIMUM_PAIRING_WINDOW_MS) {
    throw new Error('The local device returned an invalid approval window');
  }
}

async function verifyReceipt(
  receiptInput: unknown,
  offer: ComputerPairingOffer,
  deviceId: string,
): Promise<z.infer<typeof pairingReceiptSchema>> {
  const receipt = pairingReceiptSchema.parse(receiptInput);
  if (
    receipt.bridgeId !== offer.bridgeId ||
    receipt.bridgeKeyFingerprint !== offer.bridgeKeyFingerprint ||
    receipt.transportSecurity !== offer.transportSecurity ||
    receipt.bridgeEndpoint !== offer.bridgeEndpoint ||
    receipt.tlsCertificateFingerprint !== offer.tlsCertificateFingerprint ||
    receipt.deviceId !== deviceId
  ) {
    throw new Error('The local-device approval did not match this pairing code');
  }
  const { signature, ...unsignedReceipt } = receipt;
  if (!(await verify(offer.bridgePublicKeySpki, canonicalJson(unsignedReceipt), signature))) {
    throw new Error('The local-device approval signature is invalid');
  }
  return receipt;
}

function summary(credential: PairedComputerCredential): PairedComputerSummary {
  return {
    bridgeId: credential.bridgeId,
    computerName: credential.computerName,
    pairedAt: credential.pairedAt,
    permissions: [...credential.permissions],
    transportKind: computerTransportKind(credential.endpoint),
  };
}

function bridgeIdentityMatches(
  credential: PairedComputerCredential,
  offer: ComputerPairingOffer,
): boolean {
  return (
    credential.bridgeId === offer.bridgeId &&
    credential.bridgePublicKeySpki === offer.bridgePublicKeySpki &&
    credential.bridgeKeyFingerprint === offer.bridgeKeyFingerprint &&
    credential.tlsCertificateFingerprint === offer.tlsCertificateFingerprint
  );
}

async function migratePairedComputerEndpoint(
  current: PairedComputerCredential,
  offer: ComputerPairingOffer,
  options: PairComputerOptions,
): Promise<PairedComputerSummary> {
  if (!bridgeIdentityMatches(current, offer)) {
    throw new Error('The pairing code does not match the paired local-device identity');
  }
  const candidate = pairedComputerCredentialSchema.parse({
    ...current,
    endpoint: offer.bridgeEndpoint,
    transportSecurity: offer.transportSecurity,
  });
  ensureActive(options.signal);
  notify(options, 'submitting');
  await verifyComputerBridgeCredential(candidate);
  ensureActive(options.signal);
  notify(options, 'saving');
  const latestComputers = await loadPairedComputers();
  const latestIndex = latestComputers.findIndex((computer) => computer.bridgeId === offer.bridgeId);
  const latest = latestComputers[latestIndex];
  if (!latest || !bridgeIdentityMatches(latest, offer)) {
    throw new Error('The paired local device changed while its connection was being updated');
  }
  const updated = pairedComputerCredentialSchema.parse({
    ...latest,
    endpoint: offer.bridgeEndpoint,
    transportSecurity: offer.transportSecurity,
  });
  await storePairedComputers([
    ...latestComputers.slice(0, latestIndex),
    updated,
    ...latestComputers.slice(latestIndex + 1),
  ]);
  notify(options, 'complete');
  return summary(updated);
}

async function removeRevokedComputerForFreshPairing(
  current: PairedComputerCredential,
  offer: ComputerPairingOffer,
): Promise<PairedComputerCredential[]> {
  const latestComputers = await loadPairedComputers();
  const latest = latestComputers.find((computer) => computer.bridgeId === offer.bridgeId);
  if (!latest || !bridgeIdentityMatches(current, offer) || !bridgeIdentityMatches(latest, offer)) {
    throw new Error('The paired local device changed while its authorization was being recovered');
  }
  const remaining = latestComputers.filter((computer) => computer.bridgeId !== offer.bridgeId);
  await storePairedComputers(remaining);
  await deleteDeviceIdentity(latest.deviceKeyId);
  return remaining;
}

function postPairingJson(
  offer: ComputerPairingOffer,
  path: '/v1/pair/submit' | '/v1/pair/status',
  input: unknown,
) {
  return offer.transportSecurity === 'tailscale_wireguard'
    ? postTailnetBridgeJson(offer.bridgeEndpoint, path, input)
    : postPinnedBridgeJson(offer.bridgeEndpoint, path, offer.tlsCertificateFingerprint, input);
}

async function performComputerPairing(
  payload: string,
  options: PairComputerOptions,
): Promise<PairedComputerSummary> {
  const pairingRuntime = runtime();
  ensureActive(options.signal);
  notify(options, 'validating');
  const now = pairingRuntime.now();
  const offer = parseOffer(payload, now);
  const computerName = deviceNameSchema.parse(
    options.useConnectorComputerName && offer.computerName
      ? offer.computerName
      : options.computerName,
  );
  const deviceName = deviceNameSchema.parse(options.deviceName ?? 'Otterin (Mac)');
  notify(options, 'checking_bridge_identity');
  if ((await fingerprintPublicKeySpki(offer.bridgePublicKeySpki)) !== offer.bridgeKeyFingerprint) {
    throw new Error('The pairing code has an invalid bridge identity');
  }
  notify(options, 'loading_existing_pairing');
  let initialComputers = await loadPairedComputers();
  const existingComputer = initialComputers.find(
    (computer) => computer.bridgeId === offer.bridgeId,
  );
  if (existingComputer) {
    try {
      return await migratePairedComputerEndpoint(existingComputer, offer, options);
    } catch (error) {
      if (!(error instanceof ComputerBridgeError) || error.code !== 'authorization_failed') {
        throw error;
      }
      initialComputers = await removeRevokedComputerForFreshPairing(existingComputer, offer);
    }
  }
  if (initialComputers.length >= 8)
    throw new Error('Remove a paired local device before adding another');

  notify(options, 'creating_device_identity');
  const identity = await createDeviceIdentity();
  const deviceId = `device_${identity.keyId.replaceAll('-', '')}`;
  let stored = false;
  try {
    ensureActive(options.signal);
    notify(options, 'preparing_secure_request');
    const unsignedRequest = unsignedPairingRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      bridgeId: offer.bridgeId,
      pairingId: offer.pairingId,
      bridgeKeyFingerprint: offer.bridgeKeyFingerprint,
      transportSecurity: offer.transportSecurity,
      bridgeEndpoint: offer.bridgeEndpoint,
      tlsCertificateFingerprint: offer.tlsCertificateFingerprint,
      deviceId,
      deviceName,
      devicePublicKeySpki: identity.publicKeySpki,
    });
    const proof = await hmacSha256(offer.pairingSecret, canonicalJson(unsignedRequest));
    notify(options, 'submitting');
    const submission = await postPairingJson(offer, '/v1/pair/submit', {
      ...unsignedRequest,
      proof,
    });
    ensureActive(options.signal);
    if (submission.status !== 202) {
      throw new Error('The local device did not accept the pairing request');
    }
    const pending = pendingSubmissionSchema.parse(submission.body);
    validatePendingExpiry(pending.expiresAt, pairingRuntime.now());
    notify(options, 'waiting_for_approval');

    let receipt: z.infer<typeof pairingReceiptSchema> | undefined;
    while (pairingRuntime.now() < pending.expiresAt) {
      ensureActive(options.signal);
      const remaining = pending.expiresAt - pairingRuntime.now();
      await pairingRuntime.wait(Math.min(DEFAULT_POLL_INTERVAL_MS, remaining), options.signal);
      ensureActive(options.signal);
      const poll = await postPairingJson(offer, '/v1/pair/status', {
        protocolVersion: PROTOCOL_VERSION,
        bridgeId: offer.bridgeId,
        pairingId: offer.pairingId,
        pollToken: pending.pollToken,
      }).catch(() => null);
      ensureActive(options.signal);
      // Deviation from the iOS copy: a thrown transport error (Connector
      // restarting mid-approval, request timeout, unreachable endpoint)
      // retries on the next interval until expiresAt instead of failing the
      // whole ceremony. Non-2xx statuses and malformed bodies stay fatal.
      if (poll === null) continue;
      if (poll.status === 202) {
        const status = pendingStatusSchema.parse(poll.body);
        if (status.expiresAt !== pending.expiresAt) {
          throw new Error('The local device returned an inconsistent approval window');
        }
        continue;
      }
      if (poll.status !== 200) throw new Error('Pairing was denied or expired');
      const approved = approvedStatusSchema.parse(poll.body);
      receipt = await verifyReceipt(approved.receipt, offer, deviceId);
      break;
    }
    if (!receipt) throw new Error('Pairing approval expired');

    notify(options, 'saving');
    const latestComputers = await loadPairedComputers();
    if (latestComputers.some((computer) => computer.bridgeId === offer.bridgeId)) {
      throw new Error('This local device was paired by another request');
    }
    if (latestComputers.length >= 8) {
      throw new Error('Remove a paired local device before adding another');
    }
    const credential = pairedComputerCredentialSchema.parse({
      version: 3,
      bridgeId: offer.bridgeId,
      computerName,
      endpoint: offer.bridgeEndpoint,
      transportSecurity: offer.transportSecurity,
      tlsCertificateFingerprint: offer.tlsCertificateFingerprint,
      bridgePublicKeySpki: offer.bridgePublicKeySpki,
      bridgeKeyFingerprint: offer.bridgeKeyFingerprint,
      deviceId,
      deviceKeyId: identity.keyId,
      devicePublicKeySpki: identity.publicKeySpki,
      permissions: receipt.permissions,
      pairedAt: receipt.pairedAt,
    });
    await storePairedComputers([...latestComputers, credential]);
    stored = true;
    notify(options, 'complete');
    return summary(credential);
  } catch (error) {
    if (!stored) {
      try {
        await deleteDeviceIdentity(identity.keyId);
      } catch {
        throw new Error('Local pairing failed and its temporary key could not be erased');
      }
    }
    throw error;
  }
}

export async function pairComputerFromQrPayload(
  payload: string,
  options: PairComputerOptions,
): Promise<PairedComputerSummary> {
  if (pairingInProgress) throw new Error('Another local pairing is already in progress');
  pairingInProgress = true;
  try {
    return await performComputerPairing(payload, options);
  } finally {
    pairingInProgress = false;
  }
}

export function setComputerPairingRuntimeForTests(value: PairingRuntime | undefined): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Pairing runtime overrides are test-only');
  runtimeOverride = value;
}
