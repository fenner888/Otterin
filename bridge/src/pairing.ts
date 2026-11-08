import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import * as os from 'node:os';

import { z } from 'zod';

import { canonicalJson } from './canonical';
import {
  BRIDGE_PROTOCOL_VERSION,
  bridgePermissionSchema,
  deviceNameSchema,
  deviceRecordSchema,
  opaqueIdSchema,
  transportSecuritySchema,
  type BridgePermission,
  type DeviceRecord,
} from './schemas';

const DEFAULT_OFFER_LIFETIME_MS = 120_000;
const DEFAULT_APPROVAL_LIFETIME_MS = 300_000;
const DEFAULT_MAXIMUM_OFFERS = 5;
const DEFAULT_MAXIMUM_PENDING = 20;
const DEFAULT_RECEIPT_LIFETIME_MS = 120_000;
const MAXIMUM_PROOF_ATTEMPTS = 3;
const DEFAULT_PAIRING_PERMISSIONS: BridgePermission[] = ['bridge:health', 'session:metadata:read'];

const base64UrlSchema = z
  .string()
  .min(32)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const pairingSecretSchema = base64UrlSchema.length(43);
const pollTokenSchema = base64UrlSchema.length(43);

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
        url.toString() === value
      );
    } catch {
      return false;
    }
  }, 'Bridge endpoint must be an HTTP or HTTPS origin');

export const pairingTransportSchema = z
  .object({
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
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

export const pairingOfferSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    bridgePublicKeySpki: base64UrlSchema,
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    pairingId: opaqueIdSchema,
    pairingSecret: pairingSecretSchema,
    expiresAt: z.number().int().positive(),
    computerName: deviceNameSchema.optional(),
  })
  .strict();

export const unsignedPairingRequestSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    pairingId: opaqueIdSchema,
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    deviceId: opaqueIdSchema,
    deviceName: deviceNameSchema,
    devicePublicKeySpki: base64UrlSchema,
  })
  .strict();

export const pairingRequestSchema = unsignedPairingRequestSchema
  .extend({
    proof: base64UrlSchema.length(43),
  })
  .strict();

export const pairingReceiptSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    bridgeKeyFingerprint: base64UrlSchema.length(43),
    transportSecurity: transportSecuritySchema,
    bridgeEndpoint: bridgeEndpointSchema,
    tlsCertificateFingerprint: base64UrlSchema.length(43),
    deviceId: opaqueIdSchema,
    pairedAt: z.number().int().nonnegative(),
    permissions: z.array(bridgePermissionSchema).max(bridgePermissionSchema.options.length),
  })
  .strict();

export const signedPairingReceiptSchema = pairingReceiptSchema
  .extend({
    signature: base64UrlSchema.length(86),
  })
  .strict();

export const pairingPollRequestSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    pairingId: opaqueIdSchema,
    pollToken: pollTokenSchema,
  })
  .strict();

const pairingOptionsSchema = z
  .object({
    offerLifetimeMs: z.number().int().min(10_000).max(600_000).default(DEFAULT_OFFER_LIFETIME_MS),
    approvalLifetimeMs: z
      .number()
      .int()
      .min(10_000)
      .max(900_000)
      .default(DEFAULT_APPROVAL_LIFETIME_MS),
    maximumOffers: z.number().int().min(1).max(100).default(DEFAULT_MAXIMUM_OFFERS),
    maximumPending: z.number().int().min(1).max(100).default(DEFAULT_MAXIMUM_PENDING),
    receiptLifetimeMs: z
      .number()
      .int()
      .min(10_000)
      .max(600_000)
      .default(DEFAULT_RECEIPT_LIFETIME_MS),
    computerName: deviceNameSchema.optional(),
  })
  .strict();

const pairingApprovalOptionsSchema = z
  .object({
    allowSessionContent: z.boolean().default(false),
  })
  .strict();

export const devicePermissionUpdateSchema = z
  .object({
    permissions: z.array(bridgePermissionSchema).max(bridgePermissionSchema.options.length),
    allowedSessionIds: z.array(z.string().min(1).max(512)).max(10_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.permissions).size !== value.permissions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Permissions must be unique' });
    }
    if (
      value.allowedSessionIds &&
      new Set(value.allowedSessionIds).size !== value.allowedSessionIds.length
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session scopes must be unique' });
    }
  });

export interface BridgePairingIdentity {
  bridgeId: string;
  privateKey: KeyObject;
  publicKeySpki: string;
}

export interface PairingManagerOptions {
  offerLifetimeMs?: number;
  approvalLifetimeMs?: number;
  maximumOffers?: number;
  maximumPending?: number;
  receiptLifetimeMs?: number;
  computerName?: string;
}

export interface PairingApprovalOptions {
  allowSessionContent?: boolean;
}

export interface PairingDeviceRegistry {
  register(device: DeviceRecord): Promise<boolean>;
}

export type PairingOffer = z.infer<typeof pairingOfferSchema>;
export type UnsignedPairingRequest = z.infer<typeof unsignedPairingRequestSchema>;
export type PairingRequest = z.infer<typeof pairingRequestSchema>;
export type PairingTransport = z.infer<typeof pairingTransportSchema>;
export type PairingPollRequest = z.infer<typeof pairingPollRequestSchema>;
export type PairingReceipt = z.infer<typeof pairingReceiptSchema>;
export type SignedPairingReceipt = z.infer<typeof signedPairingReceiptSchema>;
export type DevicePermissionUpdate = z.infer<typeof devicePermissionUpdateSchema>;

export function defaultComputerName(hostname = os.hostname()): string | undefined {
  try {
    const withoutControls = [...hostname]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      })
      .join('');
    const sanitized = withoutControls
      .trim()
      .replace(/\.(?:local|lan)$/i, '')
      .trim()
      .slice(0, 80)
      .trim();
    const result = deviceNameSchema.safeParse(sanitized);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

interface OfferState {
  offer: PairingOffer;
  failedProofAttempts: number;
}

interface PendingState {
  request: UnsignedPairingRequest;
  expiresAt: number;
  pollTokenHash: Buffer;
}

interface CompletedState {
  receipt: SignedPairingReceipt;
  expiresAt: number;
  pollTokenHash: Buffer;
}

export interface PendingPairingReview {
  pairingId: string;
  deviceId: string;
  deviceName: string;
  deviceKeyFingerprint: string;
  expiresAt: number;
}

export type PairingSubmissionResult =
  | { ok: true; pending: PendingPairingReview; pollToken: string }
  | {
      ok: false;
      status: 400 | 404 | 429;
      body: { error: 'invalid_request' | 'not_found' | 'busy' };
    };

export type PairingApprovalResult =
  | { ok: true; device: DeviceRecord; receipt: SignedPairingReceipt }
  | { ok: false; status: 404; body: { error: 'not_found' } };

export type PairingPollResult =
  | { ok: true; status: 202; body: { status: 'pending'; expiresAt: number } }
  | { ok: true; status: 200; body: { status: 'approved'; receipt: SignedPairingReceipt } }
  | { ok: false; status: 400 | 404; body: { error: 'invalid_request' | 'not_found' } };

function publicKeyFromSpki(value: string): KeyObject | null {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

// Truncated verification SAS shown in the approval UX: same sha256-over-SPKI-DER
// construction as bridgeKeyFingerprint, cut to a length a human can compare.
const DEVICE_KEY_FINGERPRINT_LENGTH = 12;

export function deviceKeyFingerprint(devicePublicKeySpki: string): string {
  return createHash('sha256')
    .update(Buffer.from(devicePublicKeySpki, 'base64url'))
    .digest('base64url')
    .slice(0, DEVICE_KEY_FINGERPRINT_LENGTH);
}

function withoutProof(request: PairingRequest): UnsignedPairingRequest {
  return {
    protocolVersion: request.protocolVersion,
    bridgeId: request.bridgeId,
    pairingId: request.pairingId,
    bridgeKeyFingerprint: request.bridgeKeyFingerprint,
    transportSecurity: request.transportSecurity,
    bridgeEndpoint: request.bridgeEndpoint,
    tlsCertificateFingerprint: request.tlsCertificateFingerprint,
    deviceId: request.deviceId,
    deviceName: request.deviceName,
    devicePublicKeySpki: request.devicePublicKeySpki,
  };
}

function validateNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Pairing lifecycle time is invalid');
  }
  return now;
}

export function createPairingProof(pairingSecret: string, request: UnsignedPairingRequest): string {
  const secret = pairingSecretSchema.parse(pairingSecret);
  const parsedRequest = unsignedPairingRequestSchema.parse(request);
  const secretBytes = Buffer.from(secret, 'base64url');
  try {
    return createHmac('sha256', secretBytes)
      .update(canonicalJson(parsedRequest), 'utf8')
      .digest('base64url');
  } finally {
    secretBytes.fill(0);
  }
}

function proofIsValid(secret: string, request: PairingRequest): boolean {
  try {
    const expected = Buffer.from(createPairingProof(secret, withoutProof(request)), 'base64url');
    const received = Buffer.from(request.proof, 'base64url');
    const valid = expected.length === received.length && timingSafeEqual(expected, received);
    expected.fill(0);
    received.fill(0);
    return valid;
  } catch {
    return false;
  }
}

export function revokeDeviceRecord(input: unknown): DeviceRecord {
  const device = deviceRecordSchema.parse(input);
  return { ...device, status: 'revoked' };
}

export function updateDevicePermissions(input: unknown, update: unknown): DeviceRecord {
  const device = deviceRecordSchema.parse(input);
  const parsedUpdate = devicePermissionUpdateSchema.parse(update);
  return deviceRecordSchema.parse({ ...device, ...parsedUpdate });
}

export function verifyPairingReceipt(
  receipt: unknown,
  bridgePublicKeySpki: string,
  expectedBridgeId: string,
  expectedTransport: unknown,
): boolean {
  const result = signedPairingReceiptSchema.safeParse(receipt);
  const bridgeIdResult = opaqueIdSchema.safeParse(expectedBridgeId);
  const publicKey = publicKeyFromSpki(bridgePublicKeySpki);
  const transportResult = pairingTransportSchema.safeParse(expectedTransport);
  if (!result.success || !bridgeIdResult.success || !transportResult.success || !publicKey) {
    return false;
  }
  const expectedFingerprint = createHash('sha256')
    .update(Buffer.from(bridgePublicKeySpki, 'base64url'))
    .digest('base64url');
  if (
    result.data.bridgeId !== bridgeIdResult.data ||
    result.data.bridgeKeyFingerprint !== expectedFingerprint ||
    result.data.transportSecurity !== transportResult.data.transportSecurity ||
    result.data.bridgeEndpoint !== transportResult.data.bridgeEndpoint ||
    result.data.tlsCertificateFingerprint !== transportResult.data.tlsCertificateFingerprint
  ) {
    return false;
  }
  const { signature, ...unsigned } = result.data;
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export class PairingManager {
  private readonly offers = new Map<string, OfferState>();
  private readonly pending = new Map<string, PendingState>();
  private readonly completed = new Map<string, CompletedState>();
  private readonly options: z.infer<typeof pairingOptionsSchema>;
  private readonly bridgeKeyFingerprint: string;
  private readonly bridgeId: string;
  private readonly bridgePrivateKey: KeyObject;
  private readonly bridgePublicKeySpki: string;

  constructor(
    identity: BridgePairingIdentity,
    private readonly devices: PairingDeviceRegistry,
    options: PairingManagerOptions = {},
  ) {
    opaqueIdSchema.parse(identity.bridgeId);
    base64UrlSchema.parse(identity.publicKeySpki);
    if (
      identity.privateKey.type !== 'private' ||
      identity.privateKey.asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('Bridge pairing identity requires an Ed25519 private key');
    }
    const publicKey = publicKeyFromSpki(identity.publicKeySpki);
    if (!publicKey) throw new Error('Bridge pairing identity requires an Ed25519 public key');
    const identityCheck = Buffer.from('devinx-bridge-identity-check', 'utf8');
    const identitySignature = sign(null, identityCheck, identity.privateKey);
    if (!verify(null, identityCheck, publicKey, identitySignature)) {
      throw new Error('Bridge pairing identity keys do not match');
    }

    this.bridgeId = identity.bridgeId;
    this.bridgePrivateKey = identity.privateKey;
    this.bridgePublicKeySpki = identity.publicKeySpki;
    this.bridgeKeyFingerprint = createHash('sha256')
      .update(Buffer.from(identity.publicKeySpki, 'base64url'))
      .digest('base64url');
    this.options = pairingOptionsSchema.parse(options);
  }

  private cleanup(now: number): void {
    for (const [pairingId, state] of this.offers) {
      if (state.offer.expiresAt <= now) this.deleteOffer(pairingId);
    }
    for (const [pairingId, state] of this.pending) {
      if (state.expiresAt <= now) this.deletePending(pairingId);
    }
    for (const [pairingId, state] of this.completed) {
      if (state.expiresAt <= now) this.deleteCompleted(pairingId);
    }
  }

  createOffer(transportInput: unknown, now = Date.now()): PairingOffer {
    validateNow(now);
    this.cleanup(now);
    const transport = pairingTransportSchema.parse(transportInput);
    if (this.offers.size >= this.options.maximumOffers) {
      throw new Error('Pairing offer capacity reached');
    }
    const offer = pairingOfferSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: this.bridgeId,
      bridgePublicKeySpki: this.bridgePublicKeySpki,
      bridgeKeyFingerprint: this.bridgeKeyFingerprint,
      ...transport,
      pairingId: randomBytes(18).toString('base64url'),
      pairingSecret: randomBytes(32).toString('base64url'),
      expiresAt: now + this.options.offerLifetimeMs,
      ...(this.options.computerName === undefined
        ? {}
        : { computerName: this.options.computerName }),
    });
    this.offers.set(offer.pairingId, { offer: { ...offer }, failedProofAttempts: 0 });
    return { ...offer };
  }

  submit(input: unknown, now = Date.now()): PairingSubmissionResult {
    validateNow(now);
    this.cleanup(now);
    const requestResult = pairingRequestSchema.safeParse(input);
    if (!requestResult.success) {
      return { ok: false, status: 400, body: { error: 'invalid_request' } };
    }
    const request = requestResult.data;
    const state = this.offers.get(request.pairingId);
    if (!state || request.bridgeId !== this.bridgeId) {
      return { ok: false, status: 404, body: { error: 'not_found' } };
    }
    if (!proofIsValid(state.offer.pairingSecret, request)) {
      state.failedProofAttempts += 1;
      if (state.failedProofAttempts >= MAXIMUM_PROOF_ATTEMPTS) {
        this.deleteOffer(request.pairingId);
      }
      return { ok: false, status: 404, body: { error: 'not_found' } };
    }
    if (
      request.bridgeKeyFingerprint !== state.offer.bridgeKeyFingerprint ||
      request.transportSecurity !== state.offer.transportSecurity ||
      request.bridgeEndpoint !== state.offer.bridgeEndpoint ||
      request.tlsCertificateFingerprint !== state.offer.tlsCertificateFingerprint
    ) {
      this.deleteOffer(request.pairingId);
      return { ok: false, status: 404, body: { error: 'not_found' } };
    }
    if (!publicKeyFromSpki(request.devicePublicKeySpki)) {
      this.deleteOffer(request.pairingId);
      return { ok: false, status: 400, body: { error: 'invalid_request' } };
    }
    if (this.pending.size >= this.options.maximumPending) {
      return { ok: false, status: 429, body: { error: 'busy' } };
    }

    this.deleteOffer(request.pairingId);
    const pollToken = randomBytes(32).toString('base64url');
    const pending: PendingState = {
      request: withoutProof(request),
      expiresAt: now + this.options.approvalLifetimeMs,
      pollTokenHash: this.pollTokenHash(pollToken),
    };
    this.pending.set(request.pairingId, pending);
    return {
      ok: true,
      pending: {
        pairingId: request.pairingId,
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        deviceKeyFingerprint: deviceKeyFingerprint(request.devicePublicKeySpki),
        expiresAt: pending.expiresAt,
      },
      pollToken,
    };
  }

  async approve(
    pairingId: string,
    now = Date.now(),
    optionsInput: PairingApprovalOptions = {},
  ): Promise<PairingApprovalResult> {
    validateNow(now);
    const options = pairingApprovalOptionsSchema.parse(optionsInput);
    this.cleanup(now);
    const pairingIdResult = opaqueIdSchema.safeParse(pairingId);
    if (!pairingIdResult.success) {
      return { ok: false, status: 404, body: { error: 'not_found' } };
    }
    const state = this.pending.get(pairingIdResult.data);
    if (!state) return { ok: false, status: 404, body: { error: 'not_found' } };
    this.pending.delete(pairingIdResult.data);

    try {
      const permissions: BridgePermission[] = options.allowSessionContent
        ? [...DEFAULT_PAIRING_PERMISSIONS, 'session:content:read']
        : [...DEFAULT_PAIRING_PERMISSIONS];
      const device = deviceRecordSchema.parse({
        bridgeId: this.bridgeId,
        deviceId: state.request.deviceId,
        deviceName: state.request.deviceName,
        publicKeySpki: state.request.devicePublicKeySpki,
        status: 'active',
        pairedAt: now,
        permissions,
      });
      const receipt = pairingReceiptSchema.parse({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        bridgeId: this.bridgeId,
        bridgeKeyFingerprint: this.bridgeKeyFingerprint,
        transportSecurity: state.request.transportSecurity,
        bridgeEndpoint: state.request.bridgeEndpoint,
        tlsCertificateFingerprint: state.request.tlsCertificateFingerprint,
        deviceId: device.deviceId,
        pairedAt: now,
        permissions: device.permissions,
      });
      const storedDevice: DeviceRecord = {
        ...device,
        permissions: [...device.permissions],
        allowedSessionIds: device.allowedSessionIds ? [...device.allowedSessionIds] : undefined,
      };
      const signedReceipt = signedPairingReceiptSchema.parse({
        ...receipt,
        signature: sign(
          null,
          Buffer.from(canonicalJson(receipt), 'utf8'),
          this.bridgePrivateKey,
        ).toString('base64url'),
      });
      if (!(await this.devices.register(storedDevice))) {
        state.pollTokenHash.fill(0);
        return { ok: false, status: 404, body: { error: 'not_found' } };
      }
      this.completed.set(pairingIdResult.data, {
        receipt: { ...signedReceipt, permissions: [...signedReceipt.permissions] },
        expiresAt: now + this.options.receiptLifetimeMs,
        pollTokenHash: state.pollTokenHash,
      });
      return {
        ok: true,
        device: {
          ...device,
          permissions: [...device.permissions],
          allowedSessionIds: device.allowedSessionIds ? [...device.allowedSessionIds] : undefined,
        },
        receipt: signedReceipt,
      };
    } catch (error) {
      state.pollTokenHash.fill(0);
      throw error;
    }
  }

  deny(pairingId: string): boolean {
    const pairingIdResult = opaqueIdSchema.safeParse(pairingId);
    if (!pairingIdResult.success) return false;
    return this.deletePending(pairingIdResult.data);
  }

  pendingReviews(now = Date.now()): PendingPairingReview[] {
    validateNow(now);
    this.cleanup(now);
    return [...this.pending.entries()].map(([pairingId, state]) => ({
      pairingId,
      deviceId: state.request.deviceId,
      deviceName: state.request.deviceName,
      deviceKeyFingerprint: deviceKeyFingerprint(state.request.devicePublicKeySpki),
      expiresAt: state.expiresAt,
    }));
  }

  poll(input: unknown, now = Date.now()): PairingPollResult {
    validateNow(now);
    this.cleanup(now);
    const requestResult = pairingPollRequestSchema.safeParse(input);
    if (!requestResult.success) {
      return { ok: false, status: 400, body: { error: 'invalid_request' } };
    }
    const request = requestResult.data;
    if (request.bridgeId !== this.bridgeId) {
      return { ok: false, status: 404, body: { error: 'not_found' } };
    }
    const pending = this.pending.get(request.pairingId);
    if (pending && this.pollTokenIsValid(request.pollToken, pending.pollTokenHash)) {
      return { ok: true, status: 202, body: { status: 'pending', expiresAt: pending.expiresAt } };
    }
    const completed = this.completed.get(request.pairingId);
    if (completed && this.pollTokenIsValid(request.pollToken, completed.pollTokenHash)) {
      const receipt = {
        ...completed.receipt,
        permissions: [...completed.receipt.permissions],
      };
      this.deleteCompleted(request.pairingId);
      return { ok: true, status: 200, body: { status: 'approved', receipt } };
    }
    return { ok: false, status: 404, body: { error: 'not_found' } };
  }

  verifyReceipt(receipt: unknown, expectedTransport: unknown): boolean {
    return verifyPairingReceipt(
      receipt,
      this.bridgePublicKeySpki,
      this.bridgeId,
      expectedTransport,
    );
  }

  private pollTokenHash(pollToken: string): Buffer {
    const tokenBytes = Buffer.from(pollTokenSchema.parse(pollToken), 'base64url');
    try {
      return createHash('sha256').update(tokenBytes).digest();
    } finally {
      tokenBytes.fill(0);
    }
  }

  private deleteOffer(pairingId: string): boolean {
    const state = this.offers.get(pairingId);
    if (!state) return false;
    state.offer.pairingSecret = '';
    return this.offers.delete(pairingId);
  }

  private pollTokenIsValid(pollToken: string, expected: Buffer): boolean {
    try {
      const received = this.pollTokenHash(pollToken);
      const valid = received.length === expected.length && timingSafeEqual(received, expected);
      received.fill(0);
      return valid;
    } catch {
      return false;
    }
  }

  private deletePending(pairingId: string): boolean {
    const state = this.pending.get(pairingId);
    if (!state) return false;
    state.pollTokenHash.fill(0);
    return this.pending.delete(pairingId);
  }

  private deleteCompleted(pairingId: string): boolean {
    const state = this.completed.get(pairingId);
    if (!state) return false;
    state.pollTokenHash.fill(0);
    return this.completed.delete(pairingId);
  }
}
