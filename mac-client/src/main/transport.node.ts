// BridgeTransport implementation over node:http (PLAN §3.1).
//
// The bridge listener enforces a deliberately narrow HTTP shape:
//   - POST only, to /v1/request, /v1/pair/submit, /v1/pair/status
//   - exactly one Host header (host:port, explicit port)
//   - exactly one Content-Type: application/json (; charset=utf-8 optional)
//   - exactly one digit Content-Length, 1..256 KiB, matching the body bytes
//   - forbidden request headers -> 404: Origin, Cookie, Authorization,
//     Proxy-Authorization, Sec-Fetch-Site; Content-Encoding -> 415;
//     Transfer-Encoding -> 400 (omit Content-Length and node:http silently
//     switches to chunked encoding, so the length is always set explicitly)
// node:http never follows redirects, never sends cookies, and does not honor
// HTTP(S)_PROXY environment variables, so those invariants hold by
// construction — do not regress them by switching to fetch/undici.
//
// Timeout is 20 s. The bridge requestTimeout is 15 s and can cut first; that
// surfaces here as a transport error and callers reconcile via list/activity
// rather than blind-retrying mutations.

import { request as httpRequest } from 'node:http';
import { z } from 'zod';

import type { BridgePostResult, BridgeTransport } from '../../../client-core/src/ports';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;

const ALLOWED_STATUSES = new Set([200, 202, 400, 404, 409, 413, 415, 429, 503]);
const ALLOWED_PATHS = new Set(['/v1/request', '/v1/pair/submit', '/v1/pair/status']);

const tailnetEndpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const octets = url.hostname.split('.').map(Number);
      return (
        url.protocol === 'http:' &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === '' &&
        url.port !== '' &&
        url.toString() === value &&
        octets.length === 4 &&
        octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
        octets[0] === 100 &&
        octets[1] !== undefined &&
        octets[1] >= 64 &&
        octets[1] <= 127
      );
    } catch {
      return false;
    }
  }, 'Tailnet endpoint must be a canonical HTTP origin in 100.64.0.0/10');

export type BridgeTransportErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'invalid_endpoint'
  | 'request_too_large'
  | 'response_too_large'
  | 'invalid_response'
  | 'unsupported_transport';

export class BridgeTransportError extends Error {
  constructor(
    message: string,
    readonly code: BridgeTransportErrorCode,
  ) {
    super(message);
    this.name = 'BridgeTransportError';
  }
}

function postTailnetJson(
  endpoint: string,
  path: string,
  input: unknown,
): Promise<BridgePostResult> {
  const endpointResult = tailnetEndpointSchema.safeParse(endpoint);
  if (!endpointResult.success) {
    return Promise.reject(
      new BridgeTransportError('Bridge endpoint is not a canonical tailnet origin', 'invalid_endpoint'),
    );
  }
  if (!ALLOWED_PATHS.has(path)) {
    return Promise.reject(
      new BridgeTransportError('Bridge path is not in the protocol allowlist', 'invalid_endpoint'),
    );
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return Promise.reject(
      new BridgeTransportError('Bridge request body must be a JSON object', 'invalid_response'),
    );
  }
  const serialized = JSON.stringify(input);
  const bodyBytes = Buffer.byteLength(serialized, 'utf8');
  if (bodyBytes < 1 || bodyBytes > MAX_BODY_BYTES) {
    return Promise.reject(
      new BridgeTransportError('Bridge request exceeds the transport body limit', 'request_too_large'),
    );
  }

  const url = new URL(endpointResult.data);
  return new Promise<BridgePostResult>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        // agent:false — one connection per request. The listener caps
        // keep-alive at 5 s / 100 requests, and a reused-socket race at a
        // 1.5 s poll cadence is not worth the marginal handshake saving.
        agent: false,
        headers: {
          // Host is set by node:http from hostname:port — exactly one, with
          // the explicit port the listener requires. Do not add Origin,
          // Cookie, Authorization, Proxy-Authorization or Sec-Fetch-Site.
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': bodyBytes,
          'Cache-Control': 'no-cache',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (error: BridgeTransportError) => {
          if (!settled) {
            settled = true;
            res.destroy();
            reject(error);
          }
        };

        if (res.statusCode === undefined || !ALLOWED_STATUSES.has(res.statusCode)) {
          fail(new BridgeTransportError('Bridge returned an invalid status', 'invalid_response'));
          return;
        }
        const status = res.statusCode;
        const contentType = res.headers['content-type'];
        if (
          typeof contentType !== 'string' ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)
        ) {
          fail(new BridgeTransportError('Bridge returned an invalid content type', 'invalid_response'));
          return;
        }
        if (res.headers['content-encoding'] !== undefined) {
          fail(new BridgeTransportError('Bridge returned an encoded response', 'invalid_response'));
          return;
        }

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            fail(
              new BridgeTransportError(
                'Bridge response exceeded the transport limit',
                'response_too_large',
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          if (text.length === 0) {
            reject(new BridgeTransportError('Bridge returned an empty response', 'invalid_response'));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new BridgeTransportError('Bridge response was not valid JSON', 'invalid_response'));
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new BridgeTransportError('Bridge response was not a JSON object', 'invalid_response'));
            return;
          }
          resolve({ status, body: parsed });
        });
        res.on('error', () =>
          fail(new BridgeTransportError('Bridge response failed mid-stream', 'unavailable')),
        );
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new BridgeTransportError('Bridge request timed out', 'timeout'));
    });
    req.on('error', (error) => {
      reject(
        error instanceof BridgeTransportError
          ? error
          : new BridgeTransportError('The paired computer could not be reached', 'unavailable'),
      );
    });
    req.end(serialized);
  });
}

export const nodeBridgeTransport: BridgeTransport = {
  postTailnetBridgeJson: postTailnetJson,

  postPinnedBridgeJson(): Promise<BridgePostResult> {
    // v1 is tailnet-only (PLAN §3.1): pinned_tls exists only for the
    // standalone CLI and no pinned transport ships in this client.
    return Promise.reject(
      new BridgeTransportError(
        'Pinned bridge transport is not supported in this build',
        'unsupported_transport',
      ),
    );
  },
};
