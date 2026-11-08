// Pairing offer capture (PLAN §8, spec 021).
//
// The Connector renders the pairing offer as a QR. We capture a full-screen
// desktopCapturer source at real pixel size — window-source thumbnails are
// nondeterministically empty on Electron >=29.1 and default to 150x150 —
// and decode with jsQR.
//
// Spec-021 transit: the decoded payload is a one-shot value held ONLY in
// this module's memory — never logged, never sent to the renderer, never
// persisted. The renderer receives a redacted preview (non-secret fields)
// and consumes the payload via 'pair:submit'.

import { execFile } from 'node:child_process';
import jsQR from 'jsqr';
import { z } from 'zod';

export type PairingCaptureErrorCode =
  | 'screen_permission_denied'
  | 'qr_not_found'
  | 'qr_invalid'
  | 'connector_not_installed'
  | 'capture_unavailable';

export class PairingCaptureError extends Error {
  constructor(
    message: string,
    readonly code: PairingCaptureErrorCode,
  ) {
    super(message);
    this.name = 'PairingCaptureError';
  }
}

const CONNECTOR_APP_NAME = 'Otterin Connector';
const CONNECTOR_REOPEN_DELAY_MS = 1_500;
const MAX_CAPTURE_ATTEMPTS = 3;
const MAX_QR_PAYLOAD_BYTES = 4_096;
const MAX_IMAGE_PIXELS = 33_177_600; // 8K UHD — generous bound for canvas imports

// Redacted preview of the offer for the pairing screen. The authoritative
// schema lives in client-core computerPairing.ts — this only projects the
// non-secret display fields and deliberately excludes pairingSecret.
const offerPreviewSchema = z
  .object({
    protocolVersion: z.literal(2),
    bridgeId: z.string().min(16).max(128),
    bridgeKeyFingerprint: z.string().length(43),
    transportSecurity: z.enum(['tailscale_wireguard', 'pinned_tls']),
    pairingId: z.string().min(16).max(128),
    expiresAt: z.number().int().positive(),
    computerName: z.string().min(1).max(80).optional(),
  })
  .passthrough();
export type PairingOfferPreview = z.infer<typeof offerPreviewSchema>;

function electronApi(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * desktopCapturer bitmaps are BGRA premultiplied on macOS. jsQR wants RGBA;
 * QR codes are bimodal black/white so even a wrong channel order would
 * likely decode, but do the swap properly.
 */
export function bgraToRgba(bitmap: Buffer): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    rgba[i] = bitmap[i + 2] ?? 0;
    rgba[i + 1] = bitmap[i + 1] ?? 0;
    rgba[i + 2] = bitmap[i] ?? 0;
    rgba[i + 3] = bitmap[i + 3] ?? 0;
  }
  return rgba;
}

export function decodeQrFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    return null;
  }
  if (rgba.length !== width * height * 4) {
    return null;
  }
  const code = jsQR(rgba, width, height);
  if (code === null || code.data.length === 0 || code.data.length > MAX_QR_PAYLOAD_BYTES) {
    return null;
  }
  return code.data;
}

function assertScreenAccess(): void {
  const { systemPreferences } = electronApi();
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    throw new PairingCaptureError(
      'Screen Recording permission is off — enable it for Otterin in System Settings > Privacy & Security > Screen Recording',
      'screen_permission_denied',
    );
  }
}

/**
 * One capture pass across all displays. Returns the first decoded payload
 * that previews as a pairing offer. A QR that decodes but is not an offer
 * does not stop the scan of remaining displays — an unrelated QR code on
 * screen is not our pairing code.
 */
async function captureOnce(): Promise<string> {
  const { desktopCapturer, screen } = electronApi();
  assertScreenAccess();
  let sawNonOfferQr = false;
  for (const display of screen.getAllDisplays()) {
    const pixelWidth = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const pixelHeight = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: pixelWidth, height: pixelHeight },
        fetchWindowIcons: false,
      });
    } catch {
      continue;
    }
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    const thumbnail = source?.thumbnail;
    if (!source || !thumbnail || thumbnail.isEmpty()) {
      continue;
    }
    const bitmap = thumbnail.toBitmap();
    const size = thumbnail.getSize();
    if (bitmap.length !== size.width * size.height * 4) {
      continue;
    }
    const payload = decodeQrFromRgba(bgraToRgba(bitmap), size.width, size.height);
    if (payload === null) {
      continue;
    }
    if (offerPreviewSchema.safeParse(safeJsonParse(payload)).success) {
      return payload;
    }
    sawNonOfferQr = true;
  }
  if (sawNonOfferQr) {
    throw new PairingCaptureError(
      'The QR code on screen was not an Otterin pairing code',
      'qr_invalid',
    );
  }
  throw new PairingCaptureError(
    'No pairing QR was visible on any screen — open Otterin Connector so its pairing view is showing',
    'qr_not_found',
  );
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function reopenConnector(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', CONNECTOR_APP_NAME], (error) => {
      if (error) {
        reject(
          new PairingCaptureError(
            'Otterin Connector is not installed on this Mac',
            'connector_not_installed',
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export interface CaptureResult {
  preview: PairingOfferPreview;
  attempts: number;
}

/**
 * Capture -> decode -> stash. On qr_not_found, fires
 * `open -a "Otterin Connector"` once (its reopen handler shows the pairing
 * window), waits, then retries up to MAX_CAPTURE_ATTEMPTS captures total.
 * The payload never leaves this function's stash — see pendingOffer.
 */
export async function capturePairingOffer(): Promise<CaptureResult> {
  let lastError: PairingCaptureError | null = null;
  let reopenFired = false;
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      const payload = await captureOnce();
      const preview = previewOffer(payload);
      stashPendingOffer(payload, preview);
      return { preview, attempts: attempt };
    } catch (error) {
      if (
        error instanceof PairingCaptureError &&
        error.code !== 'qr_not_found' &&
        error.code !== 'qr_invalid'
      ) {
        throw error;
      }
      lastError =
        error instanceof PairingCaptureError
          ? error
          : new PairingCaptureError('Screen capture failed', 'capture_unavailable');
      if (!reopenFired) {
        reopenFired = true;
        await reopenConnector(); // throws connector_not_installed if absent
      }
      await wait(CONNECTOR_REOPEN_DELAY_MS);
    }
  }
  throw lastError ?? new PairingCaptureError('Screen capture failed', 'capture_unavailable');
}

/** Decode a renderer-supplied RGBA frame (canvas ImageData from a dropped
 *  screenshot — the zero-permission fallback in PLAN §8). */
export function importPairingOfferPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): CaptureResult {
  const payload = decodeQrFromRgba(rgba, width, height);
  if (payload === null) {
    throw new PairingCaptureError('No pairing QR was found in that image', 'qr_not_found');
  }
  const preview = previewOffer(payload);
  stashPendingOffer(payload, preview);
  return { preview, attempts: 1 };
}

function previewOffer(payload: string): PairingOfferPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new PairingCaptureError('The QR code was not an Otterin pairing code', 'qr_invalid');
  }
  const result = offerPreviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new PairingCaptureError('The QR code was not an Otterin pairing code', 'qr_invalid');
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// One-shot pending-offer stash. The decoded payload lives here until
// 'pair:submit' consumes it or 'pair:capture'/'pair:import' overwrites it.
// ---------------------------------------------------------------------------

interface PendingOffer {
  payload: string;
  preview: PairingOfferPreview;
  stashedAt: number;
}

let pendingOffer: PendingOffer | null = null;

function stashPendingOffer(payload: string, preview: PairingOfferPreview): void {
  pendingOffer = { payload, preview, stashedAt: Date.now() };
}

export function hasPendingOffer(): boolean {
  return pendingOffer !== null;
}

export function getPendingOfferPreview(): PairingOfferPreview | null {
  return pendingOffer?.preview ?? null;
}

export function clearPendingOffer(): void {
  pendingOffer = null;
}

/**
 * Returns the stashed payload and zeroes the slot. Refuses offers whose
 * expiry has already passed — client-core re-validates authoritatively.
 */
export function consumePendingOffer(): string {
  const offer = pendingOffer;
  pendingOffer = null;
  if (!offer) {
    throw new PairingCaptureError('No captured pairing code is waiting', 'qr_not_found');
  }
  if (offer.preview.expiresAt <= Date.now()) {
    throw new PairingCaptureError(
      'The pairing code has expired — capture a fresh one',
      'qr_invalid',
    );
  }
  return offer.payload;
}
