// Copy of src/auth/computerBridge.ts (see copy-source-sha.txt) with:
//  - `@theme/tokens` import removed (it only fed the screenshot-fixture path)
//  - `./screenshotFixtures` imports, the entire connectionForScreenshotFixture
//    block, and every isScreenshotFixtureMode() guard removed
//  - device-noun pass: "This iPhone" strings read a configurable noun that
//    defaults to "This Mac" (setClientDeviceNoun)
//  - transport results narrowed from the port's `unknown` body to a record
//    via asResponseRecord (the iOS transport already returned a record)
//  - removeComputerFromThisIPhone renamed to removeComputerFromThisDevice
import { z } from 'zod';

import { canonicalJson } from './canonicalJson';
import {
  createRequestIdentity,
  deleteDeviceIdentity,
  postPinnedBridgeJson,
  postTailnetBridgeJson,
  sign,
} from './deviceSigning';
import {
  loadPairedComputers,
  storePairedComputers,
  type PairedComputerCredential,
} from './pairedComputers';

const BRIDGE_PROTOCOL_VERSION = 2 as const;
const REQUEST_LIFETIME_MS = 15_000;
const BRIDGE_FEATURES_CACHE_TTL_MS = 60_000;
// The Mac can grant these after pairing, so the Connector remains authoritative.
const MAC_ENFORCED_GRANTS = new Set(['session:prompt:send', 'session:create']);

// Device-noun pass: the iOS source hardcodes "This iPhone" in user-facing
// error copy. The Mac client defaults to "This Mac"; the platform shell may
// set a more specific noun once at startup.
let deviceNoun = 'This Mac';

export function setClientDeviceNoun(noun: string): void {
  const trimmed = noun.trim();
  if (trimmed.length > 0) deviceNoun = trimmed;
}

export function clientDeviceNoun(): string {
  return deviceNoun;
}

const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursorSchema = z.string().min(1).max(4_096);
const bridgeIdListSchema = z
  .array(opaqueIdSchema)
  .min(1)
  .max(8)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bridge IDs must be unique' });
    }
  });
const localSessionIdSchema = z.string().regex(/^local_[A-Za-z0-9_-]{43}$/);
const interactionIdSchema = z.string().regex(/^interaction_[A-Za-z0-9_-]{43}$/);
const permissionIdSchema = z.string().regex(/^permission_[A-Za-z0-9_-]{43}$/);
const workspaceIdSchema = z.string().regex(/^workspace_[A-Za-z0-9_-]{43}$/);
const modelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:+-]+$/);
type CachedBridgeFeatures = {
  expiresAt: number;
  promise: Promise<ComputerBridgeFeatures>;
};
const bridgeFeaturesCache = new Map<string, CachedBridgeFeatures>();
const bridgeInteractionSupport = new Map<string, boolean>();
const bridgePresentationRejected = new Set<string>();
const computerModelSchema = z
  .object({
    id: modelIdSchema,
    name: z.string().min(1).max(160),
    description: z.string().min(1).max(500).optional(),
    supportsImages: z.boolean().optional(),
    badge: z.enum(['new', 'free_promo']).optional(),
    costTier: z.enum(['low', 'medium', 'high', 'free']).optional(),
    costSummary: z.string().min(1).max(200).optional(),
    recent: z.boolean().default(false),
    recommended: z.boolean().default(false),
  })
  .strict();
const bridgeMethodSchema = z.enum([
  'bridge.health',
  'bridge.features',
  'bridge.platform',
  'bridge.version',
  'device.revoke',
  'session.list',
  'session.load',
  'session.activity',
  'session.elicitation',
  'session.elicitation.respond',
  'session.permission',
  'session.permission.respond',
  'session.cancel',
  'session.prompt',
  'session.create_options',
  'session.create',
]);
const bridgeHealthBodySchema = z.object({}).strict();
const interactionOptInSchema = z.literal(true).optional();
const bridgeFeaturesBodySchema = z
  .object({
    interaction: interactionOptInSchema,
    presentation: z.literal(true).optional(),
  })
  .strict();
const bridgePlatformBodySchema = z.object({}).strict();
const bridgeVersionBodySchema = z.object({}).strict();
export const computerBridgeFeaturesSchema = z
  .object({
    sessionElicitation: z.boolean(),
    activityTimeline: z.boolean().optional(),
    permissionPrompts: z.boolean().optional(),
    sessionCancel: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
  })
  .passthrough();
const computerGrantsSchema = z
  .object({
    viewSessions: z.boolean(),
    sendPrompts: z.boolean(),
    startSessions: z.boolean(),
  });
export const computerBridgePresentationSchema = z.object({
  messageTimestamps: z.boolean(),
  grants: computerGrantsSchema.strict(),
}).passthrough();
export const computerBridgePlatformSchema = z
  .object({ platform: z.enum(['macos', 'windows', 'linux']) })
  .strict();
export const computerBridgeVersionSchema = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .strict();
const deviceRevokeBodySchema = z.object({}).strict();
const deviceRevokeResponseSchema = z.object({ revoked: z.literal(true) }).strict();
const sessionListBodySchema = z
  .object({ cursor: cursorSchema.optional(), interaction: interactionOptInSchema })
  .strict();
const sessionLoadBodySchema = z
  .object({
    sessionId: localSessionIdSchema,
    interaction: interactionOptInSchema,
    timestamps: z.literal(true).optional(),
  })
  .strict();
const sessionActivityBodySchema = z
  .object({ sessionId: localSessionIdSchema, interaction: interactionOptInSchema })
  .strict();
const computerSessionActivityKindSchema = z.enum([
  'thinking',
  'reading',
  'editing',
  'executing',
  'searching',
  'fetching',
  'responding',
]);
const computerActivityPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.replace(/\\/g, '/').split('/').includes('..'),
    'Activity paths must be workspace-relative',
  );
export const computerActivityEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    afterSequence: z.number().int().nonnegative(),
    kind: z.enum(['thought', 'tool']),
    toolKind: z
      .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])
      .optional(),
    status: z.enum([
      'running',
      'completed',
      'failed',
      'interrupted',
      'unknown',
      'awaiting_input',
      'timed_out',
    ]),
    title: z.string().min(1).max(200),
    paths: z.array(computerActivityPathSchema).max(20).optional(),
    detail: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string().max(16 * 1024 + 1024) }).strict(),
        z
          .object({
            type: z.literal('diff'),
            path: computerActivityPathSchema,
            oldText: z.string().max(16 * 1024 + 1024).optional(),
            newText: z.string().max(16 * 1024 + 1024).optional(),
          })
          .strict(),
      ])
      .optional(),
    truncated: z.boolean(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export const computerSessionActivitySchema = z
  .object({
    active: z.boolean(),
    kind: computerSessionActivityKindSchema,
    label: z.string().min(1).max(160),
    updatedAt: z.number().int().nonnegative(),
    awaiting: z.enum(['answer', 'approval']).optional(),
    terminalQuestion: z
      .object({
        questions: z
          .array(
            z
              .object({
                question: z.string().min(1).max(500),
                header: z.string().min(1).max(120).optional(),
                options: z.array(z.string().min(1).max(200)).max(20),
                multiSelect: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(4),
      })
      .strict()
      .optional(),
    turn: z
      .object({
        startedAt: z.number().int().nonnegative(),
        reply: z.string().max(100_000),
        activity: z.array(computerActivityEntrySchema).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
const sessionElicitationBodySchema = z.object({ sessionId: localSessionIdSchema }).strict();
const elicitationValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
]);
export const computerSessionElicitationSchema = z
  .object({
    interaction: z
      .object({
        id: interactionIdSchema,
        message: z.string().min(1).max(4_000),
        title: z.string().min(1).max(500).optional(),
        description: z.string().min(1).max(2_000).optional(),
        fields: z
          .array(
            z
              .object({
                key: z.string().min(1).max(160),
                type: z.enum([
                  'text',
                  'single_select',
                  'multi_select',
                  'number',
                  'integer',
                  'boolean',
                ]),
                title: z.string().min(1).max(500),
                description: z.string().min(1).max(2_000).optional(),
                required: z.boolean(),
                options: z
                  .array(
                    z
                      .object({ value: z.string().max(500), label: z.string().min(1).max(500) })
                      .strict(),
                  )
                  .max(100)
                  .optional(),
                allowOther: z.literal(true).optional(),
                minimum: z.number().finite().optional(),
                maximum: z.number().finite().optional(),
                minLength: z.number().int().min(0).max(10_000).optional(),
                maxLength: z.number().int().min(0).max(10_000).optional(),
                minItems: z.number().int().min(0).max(100).optional(),
                maxItems: z.number().int().min(0).max(100).optional(),
                defaultValue: elicitationValueSchema.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(16),
        createdAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const sessionElicitationResponseBodySchema = z.union([
  z
    .object({
      sessionId: localSessionIdSchema,
      interactionId: interactionIdSchema,
      action: z.literal('accept'),
      content: z.record(elicitationValueSchema),
    })
    .strict(),
  z
    .object({
      sessionId: localSessionIdSchema,
      interactionId: interactionIdSchema,
      action: z.enum(['decline', 'cancel']),
    })
    .strict(),
]);
export const sessionElicitationResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const sessionPermissionBodySchema = z.object({ sessionId: localSessionIdSchema }).strict();
const sessionPermissionDecisionSchema = z.enum(['allow_once', 'allow_session', 'reject_once']);
export const computerSessionPermissionSchema = z
  .object({
    permission: z
      .object({
        id: permissionIdSchema,
        title: z.string().min(1).max(200),
        toolKind: z
          .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])
          .optional(),
        command: z.string().max(2_000).optional(),
        paths: z.array(computerActivityPathSchema).max(20).optional(),
        decisions: z.array(sessionPermissionDecisionSchema).min(1).max(3),
        createdAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const sessionPermissionResponseBodySchema = z
  .object({
    sessionId: localSessionIdSchema,
    permissionId: permissionIdSchema,
    decision: sessionPermissionDecisionSchema,
  })
  .strict();
export const sessionPermissionResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const sessionPromptBodySchema = z
  .object({
    sessionId: localSessionIdSchema,
    text: z.string().trim().min(1).max(100_000),
    modelId: modelIdSchema.optional(),
    autoApprove: z.boolean().optional(),
  })
  .strict();
export const sessionPromptResponseSchema = z
  .object({ accepted: z.literal(true), sessionId: localSessionIdSchema.optional() })
  .strict();
const sessionCancelBodySchema = z.object({ sessionId: localSessionIdSchema }).strict();
const sessionCancelResponseSchema = z.object({ cancelled: z.literal(true) }).strict();
const sessionCreateOptionsBodySchema = z
  .object({
    refresh: z.boolean().optional(),
  })
  .strict();
export const sessionCreateOptionsResponseSchema = z
  .object({
    workspaces: z
      .array(z.object({ id: workspaceIdSchema, name: z.string().min(1).max(160) }).strict())
      .max(100),
    models: z.array(computerModelSchema).max(1_000),
    defaultModelId: modelIdSchema.nullable().default(null),
    catalogSource: z.enum(['live', 'recent']).default('recent'),
  })
  .strict()
  .superRefine((value, context) => {
    const modelIds = value.models.map((model) => model.id);
    if (new Set(modelIds).size !== modelIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models'],
        message: 'Model IDs must be unique',
      });
    }
    if (
      value.defaultModelId !== null &&
      !value.models.some((model) => model.id === value.defaultModelId && model.recommended)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultModelId'],
        message: 'Default model must be present and recommended',
      });
    }
  });
const sessionCreateBodySchema = z
  .object({
    workspaceId: workspaceIdSchema,
    modelId: modelIdSchema.nullable().optional(),
    text: z.string().trim().min(1).max(10_000),
    autoApprove: z.boolean().optional(),
  })
  .strict();
export const sessionCreateResponseSchema = z
  .object({ accepted: z.literal(true), sessionId: localSessionIdSchema })
  .strict();

const unsignedRequestSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    deviceId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z
      .string()
      .length(32)
      .regex(/^[A-Za-z0-9_-]+$/),
    method: bridgeMethodSchema,
    body: z.unknown(),
  })
  .strict();

const signedRequestSchema = unsignedRequestSchema
  .extend({
    signature: z
      .string()
      .length(86)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const computerBridgeHealthSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    status: z.literal('ready'),
    capabilities: z
      .object({
        sessionList: z.boolean(),
        sessionLoad: z.boolean(),
        sessionPrompt: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const computerSessionSummarySchema = z
  .object({
    id: localSessionIdSchema,
    origin: z.literal('computer'),
    workspaceName: z.string().min(1).max(160),
    hasTitle: z.boolean(),
    title: z.string().min(1).max(10_000).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    model: computerModelSchema.optional(),
    activity: z
      .object({
        active: z.boolean(),
        kind: computerSessionActivityKindSchema.optional(),
        updatedAt: z.number().int().nonnegative(),
        awaiting: z.enum(['answer', 'approval']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.hasTitle && value.title !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['title'],
        message: 'A title cannot be returned when hasTitle is false',
      });
    }
  });

export const computerLoadedSessionSchema = z
  .object({
    session: z
      .object({
        id: localSessionIdSchema,
        origin: z.literal('computer'),
        workspaceName: z.string().min(1).max(160),
        model: computerModelSchema.optional(),
      })
      .strict(),
    messages: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            source: z.enum(['user', 'devin']),
            text: z.string().max(100_000),
            createdAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
          })
          .strict(),
      )
      .max(200),
    activity: z.array(computerActivityEntrySchema).max(500).optional(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    value.messages.forEach((message, index) => {
      if (message.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'sequence'],
          message: 'Message sequence must be contiguous',
        });
      }
    });
    value.activity?.forEach((entry, index) => {
      if (entry.afterSequence > value.messages.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['activity', index, 'afterSequence'],
          message: 'Activity sequence must reference an existing message',
        });
      }
    });
  });

export const computerSessionPageSchema = z
  .object({
    sessions: z.array(computerSessionSummarySchema).max(5_000),
    nextCursor: cursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.sessions.map((session) => session.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session IDs must be unique' });
    }
  });

export type ComputerBridgeHealth = z.infer<typeof computerBridgeHealthSchema>;
export type ComputerBridgeFeatures = z.infer<typeof computerBridgeFeaturesSchema>;
export interface ComputerGrants {
  viewSessions: boolean;
  sendPrompts: boolean;
  startSessions: boolean;
}
export interface ComputerBridgePresentation {
  messageTimestamps: boolean;
  grants: ComputerGrants;
}
export type ComputerBridgePlatform = z.infer<typeof computerBridgePlatformSchema>['platform'];
export type ComputerBridgeVersionStatus =
  { kind: 'supported'; version: string } | { kind: 'legacy' };
export type ComputerActivityEntry = z.infer<typeof computerActivityEntrySchema>;
export type ComputerActivityToolKind = NonNullable<ComputerActivityEntry['toolKind']>;
export type ComputerActivityStatus = ComputerActivityEntry['status'];
export type ComputerSessionSummary = z.infer<typeof computerSessionSummarySchema>;
export type ComputerSessionPage = z.infer<typeof computerSessionPageSchema>;
export type ComputerLoadedSession = z.infer<typeof computerLoadedSessionSchema>;
export type ComputerSessionActivity = z.infer<typeof computerSessionActivitySchema>;
export type ComputerSessionElicitation = z.infer<typeof computerSessionElicitationSchema>;
export type ComputerElicitationInteraction = NonNullable<ComputerSessionElicitation['interaction']>;
export type ComputerElicitationResponse = z.infer<typeof sessionElicitationResponseBodySchema>;
export type ComputerElicitationAnswer =
  | {
      interactionId: string;
      action: 'accept';
      content: Record<string, string | number | boolean | string[]>;
    }
  | { interactionId: string; action: 'decline' | 'cancel' };
export type ComputerSessionPermission = NonNullable<
  z.infer<typeof computerSessionPermissionSchema>['permission']
>;
export type ComputerSessionPermissionDecision = z.infer<typeof sessionPermissionDecisionSchema>;
export type ComputerPermissionAnswer = {
  permissionId: string;
  decision: ComputerSessionPermissionDecision;
};
export type ComputerCreateOptions = z.infer<typeof sessionCreateOptionsResponseSchema>;
export type ComputerModel = z.infer<typeof computerModelSchema>;

export type ComputerBridgeErrorCode =
  | 'not_paired'
  | 'permission_denied'
  | 'authorization_failed'
  | 'busy'
  | 'conflict'
  | 'auto_approve_unavailable'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported_method'
  | 'invalid_request'
  | 'invalid_response'
  | 'too_many_sessions';

export class ComputerBridgeError extends Error {
  constructor(
    message: string,
    readonly code: ComputerBridgeErrorCode,
  ) {
    super(message);
    this.name = 'ComputerBridgeError';
  }
}

type SupportedMethod = z.infer<typeof bridgeMethodSchema>;

const permissionByMethod = {
  'bridge.health': 'bridge:health',
  'bridge.features': 'bridge:health',
  'bridge.platform': 'bridge:health',
  'bridge.version': 'bridge:health',
  'device.revoke': 'bridge:health',
  'session.list': 'session:metadata:read',
  'session.load': 'session:content:read',
  'session.activity': 'session:content:read',
  'session.elicitation': 'session:content:read',
  'session.elicitation.respond': 'session:prompt:send',
  'session.permission': 'session:content:read',
  'session.permission.respond': 'session:prompt:send',
  'session.cancel': 'session:prompt:send',
  'session.prompt': 'session:prompt:send',
  'session.create_options': 'session:metadata:read',
  'session.create': 'session:create',
} as const satisfies Record<SupportedMethod, PairedComputerCredential['permissions'][number]>;

function bodyForMethod(method: SupportedMethod, input: unknown): object {
  if (method === 'bridge.health') return bridgeHealthBodySchema.parse(input);
  if (method === 'bridge.features') return bridgeFeaturesBodySchema.parse(input);
  if (method === 'bridge.platform') return bridgePlatformBodySchema.parse(input);
  if (method === 'bridge.version') return bridgeVersionBodySchema.parse(input);
  if (method === 'device.revoke') return deviceRevokeBodySchema.parse(input);
  if (method === 'session.list') return sessionListBodySchema.parse(input);
  if (method === 'session.load') return sessionLoadBodySchema.parse(input);
  if (method === 'session.activity') return sessionActivityBodySchema.parse(input);
  if (method === 'session.elicitation') return sessionElicitationBodySchema.parse(input);
  if (method === 'session.elicitation.respond') {
    return sessionElicitationResponseBodySchema.parse(input);
  }
  if (method === 'session.permission') return sessionPermissionBodySchema.parse(input);
  if (method === 'session.permission.respond') {
    return sessionPermissionResponseBodySchema.parse(input);
  }
  if (method === 'session.cancel') return sessionCancelBodySchema.parse(input);
  if (method === 'session.prompt') return sessionPromptBodySchema.parse(input);
  if (method === 'session.create_options') return sessionCreateOptionsBodySchema.parse(input);
  return sessionCreateBodySchema.parse(input);
}

const bridgeBusyResponseSchema = z.object({ error: z.literal('busy') }).strict();

function publicResponseError(
  status: number,
  method: SupportedMethod,
  body: Record<string, unknown>,
): ComputerBridgeError {
  if (status === 404) {
    return new ComputerBridgeError(
      `${deviceNoun} is no longer authorized by the paired local device.`,
      'authorization_failed',
    );
  }
  if (status === 429) {
    if (bridgeBusyResponseSchema.safeParse(body).success) {
      return new ComputerBridgeError('The paired local device is finishing another read.', 'busy');
    }
    return new ComputerBridgeError(
      'The paired local device is receiving requests too quickly.',
      'rate_limited',
    );
  }
  if (status === 409) {
    if (body.error === 'auto_approve_unavailable') {
      return new ComputerBridgeError(
        "Auto-approve isn't available on this local device.",
        'auto_approve_unavailable',
      );
    }
    if (method === 'session.cancel' && body.error === 'conflict') {
      return new ComputerBridgeError('The session is not running in the Connector.', 'conflict');
    }
    return new ComputerBridgeError('Devin is finishing the previous turn.', 'busy');
  }
  if (status === 503) {
    return new ComputerBridgeError(
      'The paired local device is temporarily unavailable.',
      'unavailable',
    );
  }
  if (status === 400 && (method === 'bridge.platform' || method === 'bridge.version')) {
    return new ComputerBridgeError(
      'The paired local device does not support version negotiation.',
      'unsupported_method',
    );
  }
  if (status === 400 && body.error === 'invalid_request') {
    return new ComputerBridgeError(
      'The paired local device rejected an invalid request.',
      'invalid_request',
    );
  }
  return new ComputerBridgeError(
    'The paired local device rejected an invalid request.',
    'invalid_response',
  );
}

// The BridgeTransport port types the response body as `unknown`; the iOS
// transport it replaces already narrowed it to a record. Non-record bodies
// coerce to {} so error mapping and downstream safeParses behave the same.
function asResponseRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

async function validatedComputerRegistry(): Promise<PairedComputerCredential[]> {
  let computers: PairedComputerCredential[];
  try {
    computers = await loadPairedComputers();
  } catch {
    throw new ComputerBridgeError(
      'Paired local-device credentials could not be validated.',
      'not_paired',
    );
  }
  return computers;
}

async function requestComputer(
  credential: PairedComputerCredential,
  method: SupportedMethod,
  input: unknown,
): Promise<{ body: Record<string, unknown>; credential: PairedComputerCredential }> {
  const requiredPermission = permissionByMethod[method];
  if (
    !MAC_ENFORCED_GRANTS.has(requiredPermission) &&
    !credential.permissions.includes(requiredPermission)
  ) {
    throw new ComputerBridgeError(
      `${deviceNoun} does not have permission for that local request.`,
      'permission_denied',
    );
  }
  const body = bodyForMethod(method, input);
  const requestIdentity = await createRequestIdentity();
  const issuedAt = Date.now();
  const unsigned = unsignedRequestSchema.parse({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    bridgeId: credential.bridgeId,
    deviceId: credential.deviceId,
    requestId: requestIdentity.requestId,
    issuedAt,
    expiresAt: issuedAt + REQUEST_LIFETIME_MS,
    nonce: requestIdentity.nonce,
    method,
    body,
  });
  const signature = await sign(credential.deviceKeyId, canonicalJson(unsigned));
  const envelope = signedRequestSchema.parse({ ...unsigned, signature });

  try {
    const response =
      credential.transportSecurity === 'tailscale_wireguard'
        ? await postTailnetBridgeJson(credential.endpoint, '/v1/request', envelope)
        : await postPinnedBridgeJson(
            credential.endpoint,
            '/v1/request',
            credential.tlsCertificateFingerprint,
            envelope,
          );
    if (response.status !== 200) {
      throw publicResponseError(response.status, method, asResponseRecord(response.body));
    }
    return { body: asResponseRecord(response.body), credential };
  } catch (error) {
    if (error instanceof ComputerBridgeError) throw error;
    throw new ComputerBridgeError(
      'The paired local device could not be reached securely.',
      'unavailable',
    );
  }
}

async function requestHealth(credential: PairedComputerCredential): Promise<ComputerBridgeHealth> {
  const response = await requestComputer(credential, 'bridge.health', {});
  const result = computerBridgeHealthSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid health response.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestFeatures(
  credential: PairedComputerCredential,
): Promise<ComputerBridgeFeatures> {
  const cached = bridgeFeaturesCache.get(credential.bridgeId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const entry: CachedBridgeFeatures = {
    expiresAt: Date.now() + BRIDGE_FEATURES_CACHE_TTL_MS,
    promise: Promise.resolve({ sessionElicitation: false }),
  };
  const promise = requestFeaturesUncached(credential);
  entry.promise = promise;
  bridgeFeaturesCache.set(credential.bridgeId, entry);
  promise.then(
    (features) => {
      if (features.permissionPrompts === true) {
        bridgeInteractionSupport.set(credential.bridgeId, true);
      } else {
        bridgeInteractionSupport.delete(credential.bridgeId);
      }
      if (features.permissionPrompts === undefined) {
        if (bridgeFeaturesCache.get(credential.bridgeId) === entry) {
          bridgeFeaturesCache.delete(credential.bridgeId);
        }
        return;
      }
    },
    () => {
      if (bridgeFeaturesCache.get(credential.bridgeId) === entry) {
        bridgeFeaturesCache.delete(credential.bridgeId);
      }
    },
  );
  return promise;
}

async function requestFeaturesUncached(
  credential: PairedComputerCredential,
): Promise<ComputerBridgeFeatures> {
  try {
    return await requestFeatureResponse(credential, { interaction: true });
  } catch (error) {
    if (
      error instanceof ComputerBridgeError &&
      (error.code === 'invalid_request' || error.code === 'invalid_response')
    ) {
      try {
        return await requestFeatureResponse(credential, {});
      } catch (legacyError) {
        if (
          legacyError instanceof ComputerBridgeError &&
          (legacyError.code === 'invalid_request' || legacyError.code === 'invalid_response')
        ) {
          return { sessionElicitation: false, activityTimeline: false };
        }
        throw legacyError;
      }
    }
    throw error;
  }
}

async function requestFeatureResponse(
  credential: PairedComputerCredential,
  body: { interaction?: true },
): Promise<ComputerBridgeFeatures> {
  const response = await requestComputer(credential, 'bridge.features', body);
  const result = computerBridgeFeaturesSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned invalid feature information.',
      'invalid_response',
    );
  }
  return {
    ...result.data,
    activityTimeline: result.data.activityTimeline ?? false,
  };
}

function interactionSupported(credential: PairedComputerCredential): boolean {
  return bridgeInteractionSupport.get(credential.bridgeId) === true;
}

async function requestWithInteractionFallback<T>(
  credential: PairedComputerCredential,
  request: (includeInteraction: boolean) => Promise<T>,
): Promise<T> {
  if (!interactionSupported(credential)) return request(false);

  try {
    return await request(true);
  } catch (error) {
    if (!(error instanceof ComputerBridgeError) || error.code !== 'invalid_request') {
      throw error;
    }
    bridgeInteractionSupport.delete(credential.bridgeId);
    return request(false);
  }
}

async function requestPlatform(
  credential: PairedComputerCredential,
): Promise<ComputerBridgePlatform | 'unknown'> {
  try {
    const response = await requestComputer(credential, 'bridge.platform', {});
    const result = computerBridgePlatformSchema.safeParse(response.body);
    if (!result.success) {
      throw new ComputerBridgeError(
        'The paired local device returned invalid platform information.',
        'invalid_response',
      );
    }
    return result.data.platform;
  } catch (error) {
    if (error instanceof ComputerBridgeError && error.code === 'unsupported_method') {
      return 'unknown';
    }
    throw error;
  }
}

async function requestVersion(
  credential: PairedComputerCredential,
): Promise<ComputerBridgeVersionStatus> {
  try {
    const response = await requestComputer(credential, 'bridge.version', {});
    const result = computerBridgeVersionSchema.safeParse(response.body);
    if (!result.success) {
      throw new ComputerBridgeError(
        'The paired local device returned invalid version information.',
        'invalid_response',
      );
    }
    return { kind: 'supported', version: result.data.version };
  } catch (error) {
    if (error instanceof ComputerBridgeError && error.code === 'unsupported_method') {
      return { kind: 'legacy' };
    }
    throw error;
  }
}

async function requestDeviceRevocation(credential: PairedComputerCredential): Promise<void> {
  const response = await requestComputer(credential, 'device.revoke', {});
  if (!deviceRevokeResponseSchema.safeParse(response.body).success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid revocation response.',
      'invalid_response',
    );
  }
}

async function requestSessionList(
  credential: PairedComputerCredential,
  input: { cursor?: string; interaction?: true } = {},
): Promise<ComputerSessionPage> {
  const body = sessionListBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.list', body);
  const result = computerSessionPageSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid session list.',
      'invalid_response',
    );
  }
  if (
    !response.credential.permissions.includes('session:content:read') &&
    result.data.sessions.some((session) => session.title !== undefined)
  ) {
    throw new ComputerBridgeError(
      'The paired local device returned session content outside the device grant.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestSessionLoad(
  credential: PairedComputerCredential,
  input: { sessionId: string; interaction?: true; timestamps?: true },
): Promise<ComputerLoadedSession> {
  const body = sessionLoadBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.load', body);
  const result = computerLoadedSessionSchema.safeParse(response.body);
  if (!result.success || result.data.session.id !== body.sessionId) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid session history.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestSessionActivity(
  credential: PairedComputerCredential,
  input: { sessionId: string; interaction?: true },
): Promise<ComputerSessionActivity> {
  const body = sessionActivityBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.activity', body);
  const result = computerSessionActivitySchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned invalid session activity.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestSessionElicitation(
  credential: PairedComputerCredential,
  input: { sessionId: string },
): Promise<ComputerSessionElicitation> {
  const body = sessionElicitationBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.elicitation', body);
  const result = computerSessionElicitationSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid question.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestSessionElicitationResponse(
  credential: PairedComputerCredential,
  input: ComputerElicitationResponse,
): Promise<void> {
  const body = sessionElicitationResponseBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.elicitation.respond', body);
  if (!sessionElicitationResponseSchema.safeParse(response.body).success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid question response.',
      'invalid_response',
    );
  }
}

async function requestSessionPermission(
  credential: PairedComputerCredential,
  input: { sessionId: string },
): Promise<ComputerSessionPermission | null> {
  const body = sessionPermissionBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.permission', body);
  const result = computerSessionPermissionSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid command permission.',
      'invalid_response',
    );
  }
  return result.data.permission;
}

async function requestSessionPermissionResponse(
  credential: PairedComputerCredential,
  input: { sessionId: string } & ComputerPermissionAnswer,
): Promise<void> {
  const body = sessionPermissionResponseBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.permission.respond', body);
  if (!sessionPermissionResponseSchema.safeParse(response.body).success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid command permission response.',
      'invalid_response',
    );
  }
}

async function requestSessionCancel(
  credential: PairedComputerCredential,
  sessionId: string,
): Promise<void> {
  const body = sessionCancelBodySchema.parse({ sessionId });
  const response = await requestComputer(credential, 'session.cancel', body);
  if (!sessionCancelResponseSchema.safeParse(response.body).success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid cancellation response.',
      'invalid_response',
    );
  }
}

async function requestSessionPrompt(
  credential: PairedComputerCredential,
  input: { sessionId: string; text: string; modelId?: string; autoApprove?: boolean },
): Promise<void | { sessionId: string }> {
  const body = sessionPromptBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.prompt', body);
  const result = sessionPromptResponseSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid steering response.',
      'invalid_response',
    );
  }
  return result.data.sessionId ? { sessionId: result.data.sessionId } : undefined;
}

async function requestSessionCreateOptions(
  credential: PairedComputerCredential,
  input: { refresh?: boolean } = {},
): Promise<ComputerCreateOptions> {
  const body = sessionCreateOptionsBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.create_options', body);
  const result = sessionCreateOptionsResponseSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned invalid session creation options.',
      'invalid_response',
    );
  }
  return result.data;
}

async function requestSessionCreate(
  credential: PairedComputerCredential,
  input: { workspaceId: string; modelId?: string | null; text: string; autoApprove?: boolean },
): Promise<{ sessionId: string }> {
  const body = sessionCreateBodySchema.parse(input);
  const response = await requestComputer(credential, 'session.create', body);
  const result = sessionCreateResponseSchema.safeParse(response.body);
  if (!result.success) {
    throw new ComputerBridgeError(
      'The paired local device returned an invalid created session.',
      'invalid_response',
    );
  }
  return { sessionId: result.data.sessionId };
}

export interface ComputerBridgeConnection {
  bridgeId: string;
  getHealth(): Promise<ComputerBridgeHealth>;
  getFeatures(): Promise<ComputerBridgeFeatures>;
  getVersion(): Promise<ComputerBridgeVersionStatus>;
  listSessions(input?: { cursor?: string }): Promise<ComputerSessionPage>;
  loadSession(
    sessionId: string,
    options?: { timestamps?: boolean },
  ): Promise<ComputerLoadedSession>;
  getSessionActivity(sessionId: string): Promise<ComputerSessionActivity>;
  getSessionElicitation(sessionId: string): Promise<ComputerSessionElicitation>;
  respondToSessionElicitation(input: ComputerElicitationResponse): Promise<void>;
  getSessionPermission(sessionId: string): Promise<ComputerSessionPermission | null>;
  respondToSessionPermission(input: { sessionId: string } & ComputerPermissionAnswer): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  promptSession(
    sessionId: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): Promise<void | { sessionId: string }>;
  getCreateOptions(refresh?: boolean): Promise<ComputerCreateOptions>;
  createSession(input: {
    workspaceId: string;
    modelId?: string | null;
    text: string;
    autoApprove?: boolean;
  }): Promise<{ sessionId: string }>;
}

function connectionForCredential(credential: PairedComputerCredential): ComputerBridgeConnection {
  return {
    bridgeId: credential.bridgeId,
    getHealth: () => requestHealth(credential),
    getFeatures: () => requestFeatures(credential),
    getVersion: () => requestVersion(credential),
    listSessions: (input = {}) =>
      requestWithInteractionFallback(credential, (includeInteraction) =>
        requestSessionList(credential, {
          ...input,
          ...(includeInteraction ? { interaction: true as const } : {}),
        }),
      ),
    loadSession: (sessionId, options = {}) =>
      requestWithInteractionFallback(credential, (includeInteraction) =>
        requestSessionLoad(credential, {
          sessionId,
          ...(includeInteraction ? { interaction: true as const } : {}),
          ...(options.timestamps ? { timestamps: true as const } : {}),
        }),
      ),
    getSessionActivity: (sessionId) =>
      requestWithInteractionFallback(credential, (includeInteraction) =>
        requestSessionActivity(credential, {
          sessionId,
          ...(includeInteraction ? { interaction: true as const } : {}),
        }),
      ),
    getSessionElicitation: (sessionId) => requestSessionElicitation(credential, { sessionId }),
    respondToSessionElicitation: (input) => requestSessionElicitationResponse(credential, input),
    getSessionPermission: (sessionId) => requestSessionPermission(credential, { sessionId }),
    respondToSessionPermission: (input) => requestSessionPermissionResponse(credential, input),
    cancelSession: (sessionId) => requestSessionCancel(credential, sessionId),
    promptSession: (sessionId, text, modelId, autoApprove) =>
      requestSessionPrompt(credential, {
        sessionId,
        text,
        ...(modelId ? { modelId } : {}),
        ...(autoApprove !== undefined ? { autoApprove } : {}),
      }),
    getCreateOptions: (refresh = false) =>
      requestSessionCreateOptions(credential, refresh ? { refresh: true } : {}),
    createSession: (input) => requestSessionCreate(credential, input),
  };
}

export async function verifyComputerBridgeCredential(
  credentialInput: PairedComputerCredential,
): Promise<ComputerBridgeHealth> {
  return requestHealth(credentialInput);
}

export async function openComputerBridges(
  bridgeIdsInput: string[],
): Promise<Map<string, ComputerBridgeConnection>> {
  const bridgeIds = bridgeIdListSchema.parse(bridgeIdsInput);
  const computers = await validatedComputerRegistry();
  const credentials = new Map(computers.map((computer) => [computer.bridgeId, computer]));
  const connections = new Map<string, ComputerBridgeConnection>();
  for (const bridgeId of bridgeIds) {
    const credential = credentials.get(bridgeId);
    if (!credential || credential.transportSecurity !== 'tailscale_wireguard') {
      throw new ComputerBridgeError(
        'This local device is not paired through Tailscale.',
        'not_paired',
      );
    }
    connections.set(bridgeId, connectionForCredential(credential));
  }
  return connections;
}

export async function openComputerBridge(bridgeId: string): Promise<ComputerBridgeConnection> {
  const connections = await openComputerBridges([bridgeId]);
  const connection = connections.get(bridgeId);
  if (!connection) throw new ComputerBridgeError('This local device is not paired.', 'not_paired');
  return connection;
}

export async function getComputerBridgeHealth(bridgeId: string): Promise<ComputerBridgeHealth> {
  return (await openComputerBridge(bridgeId)).getHealth();
}

export async function getComputerBridgeFeatures(bridgeId: string): Promise<ComputerBridgeFeatures> {
  return (await openComputerBridge(bridgeId)).getFeatures();
}

export async function getComputerBridgePresentation(
  bridgeId: string,
): Promise<ComputerBridgePresentation | null> {
  if (bridgePresentationRejected.has(bridgeId)) return null;
  const computers = await validatedComputerRegistry();
  const credential = computers.find((computer) => computer.bridgeId === bridgeId);
  if (!credential || credential.transportSecurity !== 'tailscale_wireguard') {
    throw new ComputerBridgeError(
      'This local device is not paired through Tailscale.',
      'not_paired',
    );
  }

  try {
    const response = await requestComputer(credential, 'bridge.features', { presentation: true });
    const result = computerBridgePresentationSchema.safeParse(response.body);
    if (!result.success) {
      throw new ComputerBridgeError(
        'The paired local device returned invalid presentation information.',
        'invalid_response',
      );
    }
    return result.data;
  } catch (error) {
    if (
      error instanceof ComputerBridgeError &&
      (error.code === 'invalid_request' || error.code === 'invalid_response')
    ) {
      bridgePresentationRejected.add(bridgeId);
      return null;
    }
    throw error;
  }
}

export async function getComputerBridgeVersion(
  bridgeId: string,
): Promise<ComputerBridgeVersionStatus> {
  return (await openComputerBridge(bridgeId)).getVersion();
}

export async function getComputerBridgePlatform(
  bridgeId: string,
): Promise<ComputerBridgePlatform | 'unknown'> {
  const computers = await validatedComputerRegistry();
  const credential = computers.find((computer) => computer.bridgeId === bridgeId);
  if (!credential || credential.transportSecurity !== 'tailscale_wireguard') {
    throw new ComputerBridgeError(
      'This local device is not paired through Tailscale.',
      'not_paired',
    );
  }
  return requestPlatform(credential);
}

export async function listComputerSessions(
  bridgeId: string,
  input: { cursor?: string } = {},
): Promise<ComputerSessionPage> {
  return (await openComputerBridge(bridgeId)).listSessions(input);
}

export async function loadComputerSession(
  bridgeId: string,
  sessionId: string,
  options?: { timestamps?: boolean },
): Promise<ComputerLoadedSession> {
  return (await openComputerBridge(bridgeId)).loadSession(sessionId, options);
}

export async function getComputerSessionActivity(
  bridgeId: string,
  sessionId: string,
): Promise<ComputerSessionActivity> {
  return (await openComputerBridge(bridgeId)).getSessionActivity(sessionId);
}

export async function getComputerSessionElicitation(
  bridgeId: string,
  sessionId: string,
): Promise<ComputerSessionElicitation> {
  return (await openComputerBridge(bridgeId)).getSessionElicitation(sessionId);
}

export async function respondToComputerSessionElicitation(
  bridgeId: string,
  input: ComputerElicitationResponse,
): Promise<void> {
  return (await openComputerBridge(bridgeId)).respondToSessionElicitation(input);
}

export async function getComputerSessionPermission(
  bridgeId: string,
  sessionId: string,
): Promise<ComputerSessionPermission | null> {
  return (await openComputerBridge(bridgeId)).getSessionPermission(sessionId);
}

export async function respondToComputerSessionPermission(
  bridgeId: string,
  input: { sessionId: string } & ComputerPermissionAnswer,
): Promise<void> {
  return (await openComputerBridge(bridgeId)).respondToSessionPermission(input);
}

export async function cancelComputerSession(bridgeId: string, sessionId: string): Promise<void> {
  return (await openComputerBridge(bridgeId)).cancelSession(sessionId);
}

export async function promptComputerSession(
  bridgeId: string,
  sessionId: string,
  text: string,
  modelId?: string,
  autoApprove?: boolean,
): Promise<void | { sessionId: string }> {
  return (await openComputerBridge(bridgeId)).promptSession(sessionId, text, modelId, autoApprove);
}

export async function getComputerCreateOptions(
  bridgeId: string,
  refresh = false,
): Promise<ComputerCreateOptions> {
  return (await openComputerBridge(bridgeId)).getCreateOptions(refresh);
}

export async function createComputerSession(
  bridgeId: string,
  input: { workspaceId: string; modelId?: string | null; text: string; autoApprove?: boolean },
): Promise<{ sessionId: string }> {
  return (await openComputerBridge(bridgeId)).createSession(input);
}

export async function disconnectComputer(bridgeIdInput: string): Promise<void> {
  const bridgeId = opaqueIdSchema.parse(bridgeIdInput);
  const computers = await validatedComputerRegistry();
  const computer = computers.find((candidate) => candidate.bridgeId === bridgeId);
  if (!computer || computer.transportSecurity !== 'tailscale_wireguard') {
    throw new ComputerBridgeError(
      'This local device is not paired through Tailscale.',
      'not_paired',
    );
  }
  try {
    await requestDeviceRevocation(computer);
  } catch (error) {
    if (!(error instanceof ComputerBridgeError) || error.code !== 'authorization_failed') {
      throw error;
    }
  }
  await storePairedComputers(computers.filter((candidate) => candidate.bridgeId !== bridgeId));
  await deleteDeviceIdentity(computer.deviceKeyId);
}

export async function removeComputerFromThisDevice(bridgeIdInput: string): Promise<void> {
  const bridgeId = opaqueIdSchema.parse(bridgeIdInput);
  const computers = await validatedComputerRegistry();
  const computer = computers.find((candidate) => candidate.bridgeId === bridgeId);
  if (!computer || computer.transportSecurity !== 'tailscale_wireguard') {
    throw new ComputerBridgeError(
      'This local device is not paired through Tailscale.',
      'not_paired',
    );
  }
  await storePairedComputers(computers.filter((candidate) => candidate.bridgeId !== bridgeId));
  await deleteDeviceIdentity(computer.deviceKeyId);
}
