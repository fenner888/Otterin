/**
 * Error → user-copy tables, ported from the iPhone app
 * (computer-session/[id].tsx + computer list notices) with the device noun
 * switched to the Mac ("This Mac" / "your computer").
 */
import type { BridgeErrorCode, ComputerDiscoveryStatus } from './types';

export class OtterinBridgeError extends Error {
  readonly code: BridgeErrorCode | string;

  constructor(code: BridgeErrorCode | string, message?: string) {
    super(message ?? `Request failed (${code})`);
    this.name = 'OtterinBridgeError';
    this.code = code;
  }
}

export function bridgeErrorCode(error: unknown): BridgeErrorCode | null {
  if (error instanceof OtterinBridgeError) {
    return error.code as BridgeErrorCode;
  }
  return null;
}

export function publicErrorMessage(error: unknown): string {
  const code = bridgeErrorCode(error);
  if (code === null) return 'The local session could not be loaded.';
  if (
    code === 'not_paired' ||
    code === 'permission_denied' ||
    code === 'authorization_failed'
  ) {
    return 'This Mac does not have permission to read that local session.';
  }
  if (code === 'invalid_response') {
    return 'The paired computer returned an incompatible session history.';
  }
  if (code === 'rate_limited' || code === 'busy') {
    return 'The paired computer is busy. Wait a moment and try again.';
  }
  return 'Open Otterin Connector and confirm the secure local connection is available.';
}

export function promptErrorMessage(error: unknown, computerName = 'your computer'): string {
  const code = bridgeErrorCode(error);
  if (code === 'busy' || code === 'conflict') {
    return 'The connector is busy with another turn. Try again in a moment.';
  }
  if (code === 'authorization_failed') {
    return 'This Mac is no longer authorized. Pair this computer again in Settings.';
  }
  if (code === 'permission_denied' || code === 'not_paired') {
    return 'This Mac does not have permission to steer this session.';
  }
  if (code === 'rate_limited') {
    return 'Too many requests were sent. Wait a moment and try again.';
  }
  if (code === 'unavailable') {
    return `Otterin Connector is temporarily unavailable. Confirm it is running on ${computerName}.`;
  }
  if (code === 'auto_approve_unavailable') {
    return `Auto-approve isn't allowed on ${computerName} (organization policy). Your message wasn't sent.`;
  }
  return 'The message could not be sent. Try again.';
}

export function cancelErrorMessage(error: unknown, computerName = 'your computer'): string {
  const code = bridgeErrorCode(error);
  if (code === 'conflict' || code === 'busy') {
    return `This turn was started outside Otterin on ${computerName}. Stop it there.`;
  }
  return "Couldn't stop the turn. Try again.";
}

export function discoveryMessage(status: ComputerDiscoveryStatus): string | null {
  if (status.state === 'ready') return null;
  if (status.state === 'session_discovery_off') {
    return `${status.computerName} is paired. Start its Connector with Devin ACP to show sessions.`;
  }
  if (status.state === 'authorization_failed') {
    return `${status.computerName} needs to be paired again.`;
  }
  if (status.state === 'too_many_sessions') {
    return `${status.computerName} has more sessions than Otterin can list right now, so none are shown.`;
  }
  if (status.state === 'invalid_response') {
    return `${status.computerName} returned an incompatible session response.`;
  }
  if (status.state === 'busy') {
    return `${status.computerName} is busy. Showing the last session list; refresh again in a moment.`;
  }
  return `${status.computerName} is offline or Otterin Connector is not running.`;
}
