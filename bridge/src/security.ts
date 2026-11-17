import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson } from './canonical';
import type { ReplayGuard } from './replay';
import {
  bodySchemas,
  deviceRecordSchema,
  permissionByMethod,
  signedRequestEnvelopeSchema,
  type BridgeBodyByMethod,
  type BridgeMethod,
  type DeviceRecord,
  type SignedRequestEnvelope,
} from './schemas';

const DEFAULT_CLOCK_SKEW_MS = 5_000;
const DEFAULT_MAXIMUM_LIFETIME_MS = 30_000;

export interface DeviceStore {
  get(deviceId: string): unknown;
}

export interface AuthorizationContext {
  bridgeId: string;
  devices: DeviceStore;
  replayGuard: ReplayGuard;
  now?: number;
  clockSkewMs?: number;
  maximumLifetimeMs?: number;
}

export interface AuthorizedRequest<M extends BridgeMethod = BridgeMethod> {
  envelope: SignedRequestEnvelope;
  method: M;
  body: BridgeBodyByMethod[M];
  device: DeviceRecord;
}

export type RejectionCategory =
  | 'authentication'
  | 'authorization'
  | 'replay'
  | 'validation';

export interface RequestRejection {
  ok: false;
  status: 400 | 404;
  body: { error: 'invalid_request' | 'not_found' };
  auditCategory: RejectionCategory;
}

export interface RequestAuthorization {
  ok: true;
  request: AuthorizedRequest;
}

function invalidRequest(): RequestRejection {
  return {
    ok: false,
    status: 400,
    body: { error: 'invalid_request' },
    auditCategory: 'validation',
  };
}

function notFound(auditCategory: Exclude<RejectionCategory, 'validation'>): RequestRejection {
  return {
    ok: false,
    status: 404,
    body: { error: 'not_found' },
    auditCategory,
  };
}

export function signingPayload(envelope: Omit<SignedRequestEnvelope, 'signature'>): string {
  return canonicalJson(envelope);
}

function unsignedEnvelope(envelope: SignedRequestEnvelope): Omit<SignedRequestEnvelope, 'signature'> {
  return {
    protocolVersion: envelope.protocolVersion,
    bridgeId: envelope.bridgeId,
    deviceId: envelope.deviceId,
    requestId: envelope.requestId,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    method: envelope.method,
    body: envelope.body,
  };
}

function signatureIsValid(envelope: SignedRequestEnvelope, device: DeviceRecord): boolean {
  try {
    const signature = Buffer.from(envelope.signature, 'base64url');
    if (signature.length !== 64) return false;
    const publicKey = createPublicKey({
      key: Buffer.from(device.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(signingPayload(unsignedEnvelope(envelope)), 'utf8'),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

function requestTimeIsValid(
  envelope: SignedRequestEnvelope,
  now: number,
  clockSkewMs: number,
  maximumLifetimeMs: number,
): boolean {
  if (envelope.expiresAt <= envelope.issuedAt) return false;
  if (envelope.expiresAt - envelope.issuedAt > maximumLifetimeMs) return false;
  if (envelope.issuedAt > now + clockSkewMs) return false;
  if (envelope.expiresAt <= now) return false;
  return true;
}

function sessionIsAllowed(method: BridgeMethod, body: unknown, device: DeviceRecord): boolean {
  if (
    method !== 'session.load' &&
    method !== 'session.activity' &&
    method !== 'session.prompt' &&
    method !== 'session.permission' &&
    method !== 'session.permission.respond' &&
    method !== 'session.elicitation' &&
    method !== 'session.elicitation.respond' &&
    method !== 'session.cancel'
  ) {
    return true;
  }
  if (!device.allowedSessionIds) return true;
  const sessionId = (body as BridgeBodyByMethod['session.load']).sessionId;
  return device.allowedSessionIds.includes(sessionId);
}

export function authorizeRequest(
  input: unknown,
  context: AuthorizationContext,
): RequestAuthorization | RequestRejection {
  const envelopeResult = signedRequestEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) return invalidRequest();
  const envelope = envelopeResult.data;

  const deviceResult = deviceRecordSchema.safeParse(context.devices.get(envelope.deviceId));
  if (
    !deviceResult.success ||
    deviceResult.data.status !== 'active' ||
    deviceResult.data.bridgeId !== context.bridgeId ||
    envelope.bridgeId !== context.bridgeId
  ) {
    return notFound('authentication');
  }
  const device = deviceResult.data;

  const now = context.now ?? Date.now();
  const clockSkewMs = context.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const maximumLifetimeMs = context.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(clockSkewMs) ||
    clockSkewMs < 0 ||
    !Number.isSafeInteger(maximumLifetimeMs) ||
    maximumLifetimeMs < 1
  ) {
    return invalidRequest();
  }
  if (!requestTimeIsValid(envelope, now, clockSkewMs, maximumLifetimeMs)) {
    return notFound('authentication');
  }
  if (!signatureIsValid(envelope, device)) return notFound('authentication');
  if (!context.replayGuard.consume(device.deviceId, envelope.nonce, envelope.expiresAt, now)) {
    return notFound('replay');
  }

  const bodyResult = bodySchemas[envelope.method].safeParse(envelope.body);
  if (!bodyResult.success) return invalidRequest();
  const permission = permissionByMethod[envelope.method];
  if (!device.permissions.includes(permission)) return notFound('authorization');
  if (!sessionIsAllowed(envelope.method, bodyResult.data, device)) {
    return notFound('authorization');
  }

  return {
    ok: true,
    request: {
      envelope,
      method: envelope.method,
      body: bodyResult.data,
      device,
    } as AuthorizedRequest,
  };
}
