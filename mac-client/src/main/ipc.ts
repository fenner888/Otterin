// ipcMain.handle registration (PLAN §8 hardening).
//
//   - every payload is zod-validated in main before dispatch
//   - every handler is pinned to OUR window's webContents and to the top
//     frame (no iframe or foreign-webContents caller can reach a handler)
//   - domain errors map to a typed { ok:false, code, message } shape —
//     never raw errors to the renderer
//
// Electron is lazy-required so jest can import this module for schema and
// error-mapping tests without the electron binary.

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { z } from 'zod';

import { bridgeErrorCode, type ResolveBridgeConnection } from './bridge-client';
import { requireClientCoreProtocol } from './client-core-wiring';
import {
  capturePairingOffer,
  clearPendingOffer,
  consumePendingOffer,
  getPendingOfferPreview,
  importPairingOfferPixels,
  PairingCaptureError,
} from './pairing-capture';
import { SecretStoreError } from './secrets.mac';
import { BridgeTransportError } from './transport.node';
import type { PollScheduler } from './scheduler';

// -- payload schemas ---------------------------------------------------------

const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const localSessionIdSchema = z.string().regex(/^local_[A-Za-z0-9_-]{43}$/);
const interactionIdSchema = z.string().regex(/^interaction_[A-Za-z0-9_-]{43}$/);
const permissionIdSchema = z.string().regex(/^permission_[A-Za-z0-9_-]{43}$/);
const workspaceIdSchema = z.string().regex(/^workspace_[A-Za-z0-9_-]{43}$/);
const modelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:+-]+$/);
const elicitationValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
]);

const emptyPayloadSchema = z.union([
  z.undefined(),
  z.null(),
  z.object({}).strict(),
]);
const bridgeIdPayloadSchema = z.object({ bridgeId: opaqueIdSchema }).strict();
const sessionPayloadSchema = bridgeIdPayloadSchema.extend({
  sessionId: localSessionIdSchema,
});

const pairImportSchema = z
  .object({
    width: z.number().int().min(1).max(8_192),
    height: z.number().int().min(1).max(8_192),
    rgba: z.union([z.instanceof(Uint8ClampedArray), z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)]),
  })
  .strict();

// Opt-in request flags the renderer passes for protocol negotiation —
// client-core owns whether they reach the wire (and falls back on 400 for
// Connectors that predate them). Schemas just admit the flags.
const optInFlagSchema = z.literal(true).optional();

const channelSchemas = {
  'pair:capture': emptyPayloadSchema,
  'pair:import': pairImportSchema,
  'pair:preview': emptyPayloadSchema,
  'pair:submit': z
    .object({ deviceName: z.string().min(1).max(120).optional() })
    .strict(),
  'pair:cancel': emptyPayloadSchema,
  'computers:list': emptyPayloadSchema,
  'computers:disconnect': bridgeIdPayloadSchema,
  'bridge:health': bridgeIdPayloadSchema,
  'bridge:features': bridgeIdPayloadSchema
    .extend({ presentation: optInFlagSchema })
    .strict(),
  'bridge:version': bridgeIdPayloadSchema,
  'bridge:platform': bridgeIdPayloadSchema,
  'bridge:presentation': bridgeIdPayloadSchema,
  'session:list': bridgeIdPayloadSchema
    .extend({
      cursor: z.string().min(1).max(4_096).optional(),
      interaction: optInFlagSchema,
      ownership: optInFlagSchema,
    })
    .strict(),
  'session:load': sessionPayloadSchema
    .extend({ timestamps: z.boolean().optional(), interaction: optInFlagSchema })
    .strict(),
  'session:activity': sessionPayloadSchema
    .extend({ interaction: optInFlagSchema })
    .strict(),
  'session:prompt': sessionPayloadSchema
    .extend({
      text: z.string().trim().min(1).max(100_000),
      modelId: modelIdSchema.optional(),
      autoApprove: z.boolean().optional(),
    })
    .strict(),
  'session:cancel': sessionPayloadSchema,
  'session:elicitation': sessionPayloadSchema,
  'session:elicitation:respond': z.union([
    sessionPayloadSchema
      .extend({
        interactionId: interactionIdSchema,
        action: z.literal('accept'),
        content: z.record(elicitationValueSchema),
      })
      .strict(),
    sessionPayloadSchema
      .extend({
        interactionId: interactionIdSchema,
        action: z.enum(['decline', 'cancel']),
      })
      .strict(),
  ]),
  'session:permission': sessionPayloadSchema,
  'session:permission:respond': sessionPayloadSchema
    .extend({
      permissionId: permissionIdSchema,
      decision: z.enum(['allow_once', 'allow_session', 'reject_once']),
    })
    .strict(),
  'session:createOptions': bridgeIdPayloadSchema
    .extend({ refresh: z.boolean().optional() })
    .strict(),
  'session:create': bridgeIdPayloadSchema
    .extend({
      workspaceId: workspaceIdSchema,
      modelId: modelIdSchema.nullable().optional(),
      text: z.string().trim().min(1).max(10_000),
      autoApprove: z.boolean().optional(),
    })
    .strict(),
  'device:revoke': bridgeIdPayloadSchema,
  'scheduler:snapshot': emptyPayloadSchema,
  'scheduler:setSession': bridgeIdPayloadSchema
    .extend({ sessionId: localSessionIdSchema.nullable() })
    .strict(),
  'scheduler:pollNow': emptyPayloadSchema,
  'app:openConnector': emptyPayloadSchema,
  'app:openDevin': emptyPayloadSchema,
} as const;

export type OtterinIpcChannel = keyof typeof channelSchemas;
export const OTTERIN_IPC_CHANNELS = Object.keys(channelSchemas) as OtterinIpcChannel[];

export type IpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

// -- error mapping -----------------------------------------------------------

interface PublicError {
  code: string;
  message: string;
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof z.ZodError) {
    return { code: 'invalid_request', message: 'The request was malformed' };
  }
  if (error instanceof PairingCaptureError || error instanceof SecretStoreError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof BridgeTransportError) {
    return { code: 'unavailable', message: error.message };
  }
  // ComputerBridgeError and ClientCoreUnavailableError both carry a
  // user-safe `code` + `message` — forward them as authored copy.
  const code = bridgeErrorCode(error);
  if (code !== null && error instanceof Error) {
    return { code, message: error.message };
  }
  return { code: 'internal_error', message: 'An unexpected error occurred' };
}

// -- registration ------------------------------------------------------------

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  scheduler: PollScheduler;
  resolveConnection?: ResolveBridgeConnection;
}

function electronApi(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

// Launches a companion app by name (`open -a`). Fixed argv, no shell — the
// renderer cannot influence the target. Failure means "not installed" and
// surfaces as `unavailable` to the renderer.
function openMacApp(appName: 'Otterin Connector' | 'Devin'): Promise<{ opened: boolean }> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', appName], (error) => {
      if (error) {
        reject(new BridgeTransportError(`${appName} is not installed on this Mac`, 'unavailable'));
        return;
      }
      resolve({ opened: true });
    });
  });
}

function senderIsTrusted(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
): boolean {
  const win = getWindow();
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    return false;
  }
  const frame = event.senderFrame;
  // Top frame only — our renderer opens no iframes, so anything else is
  // not a caller we serve.
  return frame !== null && frame.parent === null;
}

function resolveBridge(bridgeId: string, resolve?: ResolveBridgeConnection) {
  const resolver = resolve ?? ((id: string) => requireClientCoreProtocol().openBridge(id));
  return resolver(bridgeId);
}

const computerSummaryListSchema = z.array(
  z.object({ bridgeId: z.string().min(16).max(128) }).passthrough(),
);

export function registerIpcHandlers(deps: IpcDeps): void {
  const { ipcMain } = electronApi();
  const { scheduler } = deps;
  let pairAbort: AbortController | null = null;

  const dispatch: Record<OtterinIpcChannel, (payload: unknown) => Promise<unknown>> = {
    'pair:capture': () => capturePairingOffer(),
    'pair:import': (payload) => {
      const { width, height, rgba } = pairImportSchema.parse(payload);
      const clamped =
        rgba instanceof Uint8ClampedArray
          ? rgba
          : rgba instanceof ArrayBuffer
            ? new Uint8ClampedArray(rgba)
            : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      return Promise.resolve(importPairingOfferPixels(clamped, width, height));
    },
    'pair:preview': () => Promise.resolve(getPendingOfferPreview()),
    'pair:cancel': () => {
      pairAbort?.abort();
      pairAbort = null;
      clearPendingOffer();
      return Promise.resolve({ cancelled: true });
    },
    'pair:submit': () => {
      const payload = consumePendingOffer();
      pairAbort = new AbortController();
      const controller = pairAbort;
      return requireClientCoreProtocol()
        .pairFromQrPayload(payload, controller.signal)
        .finally(() => {
          if (pairAbort === controller) {
            pairAbort = null;
          }
        });
    },
    'computers:list': () =>
      requireClientCoreProtocol()
        .loadPairedComputerSummaries()
        .then((result) => {
          // Keep the scheduler's poll set in lock-step with the registry.
          const parsed = computerSummaryListSchema.safeParse(result);
          if (parsed.success) {
            scheduler.setBridgeIds(parsed.data.map((computer) => computer.bridgeId));
          }
          return result;
        }),
    'computers:disconnect': (payload) =>
      requireClientCoreProtocol().removeComputerLocally(
        bridgeIdPayloadSchema.parse(payload).bridgeId,
      ),
    'bridge:health': (payload) =>
      resolveBridge(bridgeIdPayloadSchema.parse(payload).bridgeId, deps.resolveConnection).then(
        (connection) => connection.getHealth(),
      ),
    'bridge:features': (payload) =>
      resolveBridge(bridgeIdPayloadSchema.parse(payload).bridgeId, deps.resolveConnection).then(
        (connection) => connection.getFeatures(),
      ),
    'bridge:version': (payload) =>
      resolveBridge(bridgeIdPayloadSchema.parse(payload).bridgeId, deps.resolveConnection).then(
        (connection) => connection.getVersion(),
      ),
    'bridge:platform': (payload) =>
      resolveBridge(bridgeIdPayloadSchema.parse(payload).bridgeId, deps.resolveConnection).then(
        (connection) => connection.getPlatform(),
      ),
    'bridge:presentation': (payload) =>
      requireClientCoreProtocol().getPresentation(bridgeIdPayloadSchema.parse(payload).bridgeId),
    'session:list': (payload) => {
      const { bridgeId, cursor, ownership } = channelSchemas['session:list'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.listSessions({
          ...(cursor ? { cursor } : {}),
          ...(ownership ? { ownership } : {}),
        }),
      );
    },
    'session:load': (payload) => {
      const { bridgeId, sessionId, timestamps } = channelSchemas['session:load'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.loadSession(sessionId, { ...(timestamps ? { timestamps } : {}) }),
      );
    },
    'session:activity': (payload) => {
      const { bridgeId, sessionId } = sessionPayloadSchema.parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.getSessionActivity(sessionId),
      );
    },
    'session:prompt': (payload) => {
      const { bridgeId, sessionId, text, modelId, autoApprove } =
        channelSchemas['session:prompt'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.promptSession(sessionId, text, modelId, autoApprove),
      );
    },
    'session:cancel': (payload) => {
      const { bridgeId, sessionId } = sessionPayloadSchema.parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.cancelSession(sessionId),
      );
    },
    'session:elicitation': (payload) => {
      const { bridgeId, sessionId } = sessionPayloadSchema.parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.getSessionElicitation(sessionId),
      );
    },
    'session:elicitation:respond': (payload) => {
      const parsed = channelSchemas['session:elicitation:respond'].parse(payload);
      const { bridgeId, ...response } = parsed;
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.respondToSessionElicitation(response),
      );
    },
    'session:permission': (payload) => {
      const { bridgeId, sessionId } = sessionPayloadSchema.parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.getSessionPermission(sessionId),
      );
    },
    'session:permission:respond': (payload) => {
      const { bridgeId, sessionId, permissionId, decision } =
        channelSchemas['session:permission:respond'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.respondToSessionPermission({ sessionId, permissionId, decision }),
      );
    },
    'session:createOptions': (payload) => {
      const { bridgeId, refresh } = channelSchemas['session:createOptions'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.getCreateOptions(refresh ?? false),
      );
    },
    'session:create': (payload) => {
      const { bridgeId, workspaceId, modelId, text, autoApprove } =
        channelSchemas['session:create'].parse(payload);
      return resolveBridge(bridgeId, deps.resolveConnection).then((connection) =>
        connection.createSession({
          workspaceId,
          text,
          ...(modelId !== undefined ? { modelId } : {}),
          ...(autoApprove !== undefined ? { autoApprove } : {}),
        }),
      );
    },
    'device:revoke': (payload) =>
      requireClientCoreProtocol().disconnectComputer(
        bridgeIdPayloadSchema.parse(payload).bridgeId,
      ),
    'scheduler:snapshot': () => Promise.resolve(scheduler.getSnapshot()),
    'scheduler:setSession': (payload) => {
      const { bridgeId, sessionId } = channelSchemas['scheduler:setSession'].parse(payload);
      scheduler.setOpenSession(bridgeId, sessionId);
      return Promise.resolve({ tracking: sessionId !== null });
    },
    'scheduler:pollNow': () => {
      scheduler.pollNow();
      return Promise.resolve({ polled: true });
    },
    'app:openConnector': () => openMacApp('Otterin Connector'),
    'app:openDevin': () => openMacApp('Devin'),
  };

  for (const channel of OTTERIN_IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, payload): Promise<IpcResult> => {
      try {
        if (!senderIsTrusted(event, deps.getWindow)) {
          return {
            ok: false,
            error: { code: 'invalid_request', message: 'The request was malformed' },
          };
        }
        const parsed = channelSchemas[channel].parse(payload);
        return { ok: true, result: await dispatch[channel](parsed) };
      } catch (error) {
        const publicError = toPublicError(error);
        if (publicError.code === 'internal_error') {
          // Audit log only — never payloads, secrets, or endpoints.
          console.error(`[ipc] ${channel} failed`, error instanceof Error ? error.name : 'error');
        }
        return { ok: false, error: publicError };
      }
    });
  }
}
