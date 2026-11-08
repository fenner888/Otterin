import { execFile } from 'node:child_process';
import { basename, win32 } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
  activityEntrySchema,
  legacyActivityStatus,
  type ActivityEntry,
} from './activity';
import {
  AcpBusyError,
  AcpAutoApproveUnavailableError,
  AcpNotRunningError,
  defaultActivityLabel,
  type AcpLoadedSession,
  type AcpModelCatalog,
  type AcpPendingElicitation,
  type AcpPendingPermission,
  type AcpSessionActivity,
  type AcpSessionPage,
  type AcpSessionTurn,
} from './acp';
import type { RateLimiter, RateLimitRule } from './rate-limit';
import type { ReplayGuard } from './replay';
import {
  authorizeRequest,
  type DeviceStore,
  type RequestAuthorization,
  type RequestRejection,
} from './security';
import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeFeaturesBodySchema,
  opaqueIdSchema,
  modelIdSchema,
  permissionIdSchema,
  sessionCancelBodySchema,
  sessionCreateBodySchema,
  sessionCreateOptionsBodySchema,
  sessionActivityBodySchema,
  sessionElicitationBodySchema,
  sessionElicitationResponseBodySchema,
  sessionListBodySchema,
  sessionLoadBodySchema,
  sessionPromptBodySchema,
  sessionPermissionBodySchema,
  sessionPermissionDecisionSchema,
  sessionPermissionResponseBodySchema,
  type SessionPermissionDecision,
} from './schemas';
import { CONNECTOR_VERSION } from './version';
import type { SessionHandleRegistry } from './session-handles';
import type { WorkspaceHandleRegistry } from './workspace-handles';

const MAX_LOCAL_SESSION_RESPONSE_BYTES = 192 * 1024;
const MAX_TOTAL_ACTIVITY_DETAIL_BYTES = 160 * 1024;

const sessionCreateOptionsResponseSchema = z
  .object({
    workspaces: z
      .array(
        z
          .object({
            id: z.string().regex(/^workspace_[A-Za-z0-9_-]{43}$/),
            name: z.string().min(1).max(160),
          })
          .strict(),
      )
      .max(100),
    models: z
      .array(
        z
          .object({
            id: modelIdSchema,
            name: z.string().min(1).max(160),
            description: z.string().min(1).max(500).optional(),
            supportsImages: z.boolean().optional(),
            badge: z.enum(['new', 'free_promo']).optional(),
            costTier: z.enum(['low', 'medium', 'high', 'free']).optional(),
            costSummary: z.string().min(1).max(200).optional(),
            recent: z.boolean(),
            recommended: z.boolean(),
          })
          .strict(),
      )
      .max(1_000),
    defaultModelId: modelIdSchema.nullable(),
    catalogSource: z.enum(['live', 'recent']),
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

type SessionCreateOptionsResponse = z.infer<typeof sessionCreateOptionsResponseSchema>;

const localSessionActivityKindSchema = z.enum([
  'thinking',
  'reading',
  'editing',
  'executing',
  'searching',
  'fetching',
  'responding',
]);

const requestContextSchema = z
  .object({
    peerKey: z.string().min(1).max(128),
    now: z.number().int().nonnegative(),
  })
  .strict();

const serviceOptionsSchema = z
  .object({
    peerLimit: z.number().int().min(1).max(10_000).default(120),
    healthLimit: z.number().int().min(1).max(10_000).default(120),
    sessionListLimit: z.number().int().min(1).max(10_000).default(30),
    sessionListContinuationLimit: z.number().int().min(1).max(10_000).default(120),
    sessionLoadLimit: z.number().int().min(1).max(10_000).default(30),
    sessionActivityLimit: z.number().int().min(1).max(10_000).default(180),
    mutationLimit: z.number().int().min(1).max(10_000).default(10),
    windowMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(60_000),
  })
  .strict();

// Opt-in ownership attribution (request flag `ownership: true`). Never emitted
// unconditionally: iOS response schemas are strict and reject unknown fields.
const sessionOwnerSchema = z.enum(['free', 'locked_external', 'connector_live']);
const ownerNameSchema = z.string().min(1).max(160);

interface SessionOwnership {
  owner: z.infer<typeof sessionOwnerSchema>;
  ownerName?: string;
}

const localSessionSchema = z
  .object({
    id: z.string().regex(/^local_[A-Za-z0-9_-]{43}$/),
    origin: z.literal('computer'),
    workspaceName: z.string().min(1).max(160),
    hasTitle: z.boolean(),
    title: z.string().max(10_000).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    model: z
      .object({ id: modelIdSchema, name: z.string().min(1).max(160) })
      .strict()
      .optional(),
    activity: z
      .object({
        active: z.boolean(),
        kind: localSessionActivityKindSchema.optional(),
        updatedAt: z.number().int().nonnegative(),
        awaiting: z.enum(['answer', 'approval']).optional(),
      })
      .strict()
      .optional(),
    owner: sessionOwnerSchema.optional(),
    ownerName: ownerNameSchema.optional(),
  })
  .strict();

const healthResponseSchema = z
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

const featuresResponseSchema = z
  .object({
    sessionElicitation: z.boolean(),
    activityTimeline: z.boolean(),
    permissionPrompts: z.boolean().optional(),
    sessionCancel: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
    messageTimestamps: z.boolean().optional(),
    grants: z
      .object({
        viewSessions: z.boolean(),
        sendPrompts: z.boolean(),
        startSessions: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const platformResponseSchema = z
  .object({
    platform: z.enum(['macos', 'windows', 'linux']),
  })
  .strict();

const versionResponseSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();

const localSessionPageSchema = z
  .object({
    sessions: z.array(localSessionSchema).max(5_000),
    nextCursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

const localHistoryMessageSchema = z
  .object({
    sequence: z.number().int().positive(),
    source: z.enum(['user', 'devin']),
    text: z.string().max(100_000),
    createdAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
  })
  .strict();

const localLoadedSessionSchema = z
  .object({
    session: z
      .object({
        id: z.string().regex(/^local_[A-Za-z0-9_-]{43}$/),
        origin: z.literal('computer'),
        workspaceName: z.string().min(1).max(160),
        model: z
          .object({ id: modelIdSchema, name: z.string().min(1).max(160) })
          .strict()
          .optional(),
        owner: sessionOwnerSchema.optional(),
        ownerName: ownerNameSchema.optional(),
      })
      .strict(),
    messages: z.array(localHistoryMessageSchema).max(200),
    activity: z.array(activityEntrySchema).max(500).optional(),
    truncated: z.boolean(),
  })
  .strict();

const localSessionActivitySchema = z
  .object({
    active: z.boolean(),
    kind: localSessionActivityKindSchema,
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
                header: z.string().max(120).optional(),
                options: z.array(z.string().max(200)).max(20),
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
        activity: z.array(activityEntrySchema).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

const localSessionPermissionSchema = z
  .object({
    permission: z
      .object({
        id: permissionIdSchema,
        title: z.string().min(1).max(200),
        toolKind: z
          .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])
          .optional(),
        command: z.string().min(1).max(2_000).optional(),
        paths: z.array(z.string().min(1).max(4_096)).max(100).optional(),
        decisions: z.array(sessionPermissionDecisionSchema).min(1).max(3),
        createdAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

function interactionAwaiting(label: string): 'answer' | 'approval' | undefined {
  if (label === 'Waiting for your answer' || label === 'Waiting for your answer in Terminal') {
    return 'answer';
  }
  if (label === 'Waiting for your approval') return 'approval';
  return undefined;
}

function activityForClient(entries: ActivityEntry[], interaction: boolean): ActivityEntry[] {
  return interaction
    ? entries
    : entries.map((entry) => ({
        ...entry,
        status: legacyActivityStatus(entry.status),
      }));
}

const elicitationValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
]);

const localSessionElicitationSchema = z
  .object({
    interaction: z
      .object({
        id: z.string().regex(/^interaction_[A-Za-z0-9_-]{43}$/),
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
                      .object({
                        value: z.string().max(500),
                        label: z.string().min(1).max(500),
                      })
                      .strict(),
                  )
                  .max(100)
                  .optional(),
                minimum: z.number().finite().optional(),
                maximum: z.number().finite().optional(),
                minLength: z.number().int().min(0).max(10_000).optional(),
                maxLength: z.number().int().min(0).max(10_000).optional(),
                minItems: z.number().int().min(0).max(100).optional(),
                maxItems: z.number().int().min(0).max(100).optional(),
                allowOther: z.literal(true).optional(),
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

type LocalLoadedSession = z.infer<typeof localLoadedSessionSchema>;

export interface SessionDiscoveryAdapter {
  isSessionListSupported(): boolean;
  listSessions(input?: unknown): Promise<AcpSessionPage>;
  isSessionLoadSupported(): boolean;
  loadSession(sessionId: string): Promise<AcpLoadedSession>;
  getActiveTurnSnapshot?(sessionId: string): AcpLoadedSession | null;
  getTimedOutToolCallIds?(sessionId: string): ReadonlySet<string>;
  isSessionActivitySupported?(): boolean;
  getSessionActivity?(sessionId: string): Promise<AcpSessionActivity | null>;
  getSessionTurn?(sessionId: string): AcpSessionTurn | null | Promise<AcpSessionTurn | null>;
  // Ownership probes (opt-in `ownership` request flag). The live-lock PID comes
  // from the session store; the driver PID and connector-owned check come from
  // the ACP client. All optional: adapters lacking them omit the owner field.
  getSessionLockPid?(sessionId: string): Promise<number | null>;
  getSessionDriverPid?(): number | null;
  isSessionConnectorOwned?(sessionId: string): boolean;
  isSessionElicitationSupported?(): boolean;
  getPendingElicitation?(sessionId: string): AcpPendingElicitation | null;
  respondToElicitation?(
    sessionId: string,
    interactionId: string,
    response:
      { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' | 'cancel' },
  ): void;
  isSessionPermissionSupported?(): boolean;
  getPendingPermission?(sessionId: string): AcpPendingPermission | null;
  respondToPermission?(
    sessionId: string,
    permissionId: string,
    decision: SessionPermissionDecision,
  ): void;
  isSessionPromptSupported(): boolean;
  isSessionCancelSupported?(): boolean;
  cancelSession?(sessionId: string): void | Promise<void>;
  isSessionAutoApproveSupported?(): boolean;
  promptSession(
    sessionId: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): Promise<void | { continuedSessionId: string }>;
  createContinuation?(
    cwd: string,
    context: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): Promise<string>;
  releaseSessionOwnership?(sessionId: string): Promise<void>;
  isSessionCreateSupported?(): boolean;
  listModelCatalog?(forceRefresh?: boolean): Promise<AcpModelCatalog>;
  listCreateOptions?(forceRefresh?: boolean): Promise<{
    workspaces: Array<{ path: string }>;
    models: Array<{
      id: string;
      name?: string;
      description?: string;
      supportsImages?: boolean;
      badge?: 'new' | 'free_promo';
      costTier?: 'low' | 'medium' | 'high' | 'free';
      costSummary?: string;
      recent?: boolean;
      recommended?: boolean;
    }>;
    defaultModelId?: string | null;
    catalogSource?: 'live' | 'recent';
  }>;
  createSession?(
    cwd: string,
    modelId: string | null,
    text: string,
    autoApprove?: boolean,
  ): Promise<string>;
}

export interface BridgeServiceOptions {
  bridgeId: string;
  platform: 'macos' | 'windows' | 'linux';
  devices: DeviceStore & { revoke?(deviceId: string): Promise<boolean> };
  replayGuard: ReplayGuard;
  rateLimiter: RateLimiter;
  sessionHandles: SessionHandleRegistry;
  workspaceHandles: WorkspaceHandleRegistry;
  sessions: SessionDiscoveryAdapter;
  processNameResolver?: ProcessNameResolver;
  peerLimit?: number;
  healthLimit?: number;
  sessionListLimit?: number;
  sessionListContinuationLimit?: number;
  sessionLoadLimit?: number;
  sessionActivityLimit?: number;
  mutationLimit?: number;
  windowMs?: number;
}

export interface BridgeRequestContext {
  peerKey: string;
  now: number;
}

export interface BridgeServiceResponse {
  status: 200 | 400 | 404 | 409 | 429 | 503;
  body: unknown;
}

function publicRejection(rejection: RequestRejection): BridgeServiceResponse {
  return { status: rejection.status, body: rejection.body };
}

function cleanDisplayText(value: string, maximumLength: number, fallback: string): string {
  const characters = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  });
  const collapsed = characters.join('').replace(/\s+/g, ' ').trim();
  const clean = [...collapsed].slice(0, maximumLength).join('');
  return clean || fallback;
}

function modelDisplayName(modelId: string): string {
  const words = modelId.split(/[-_]+/).filter(Boolean);
  const labels: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (/^\d+$/.test(word)) {
      const versionParts = [word];
      while (/^\d+$/.test(words[index + 1] ?? '')) {
        versionParts.push(words[index + 1] ?? '');
        index += 1;
      }
      labels.push(versionParts.join('.'));
      continue;
    }
    labels.push(
      (() => {
        if (/^\d+(?:\.\d+)*$/.test(word)) return word;
        if (word.toLowerCase() === 'gpt') return 'GPT';
        if (word.toLowerCase() === 'glm') return 'GLM';
        return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
      })(),
    );
  }
  const label = labels.join(' ');
  return cleanDisplayText(label, 160, 'Default');
}

function workspaceDisplayNames(workspaces: Array<{ path: string }>): string[] {
  const bases = workspaces.map((workspace) =>
    cleanDisplayText(
      win32.isAbsolute(workspace.path) ? win32.basename(workspace.path) : basename(workspace.path),
      150,
      'Workspace',
    ),
  );
  const totals = new Map<string, number>();
  for (const base of bases) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  return bases.map((base) => {
    if ((totals.get(base) ?? 0) === 1) return base;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return `${base} (${occurrence})`;
  });
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitCreateOptionsResponse(
  body: SessionCreateOptionsResponse,
): SessionCreateOptionsResponse {
  if (serializedBytes(body) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) return body;

  const isDefault = (model: SessionCreateOptionsResponse['models'][number]) =>
    model.id === body.defaultModelId;
  const isPriority = (model: SessionCreateOptionsResponse['models'][number]) =>
    model.recommended || model.recent || isDefault(model);
  const withModels = (models: SessionCreateOptionsResponse['models']) => ({ ...body, models });
  const withoutDescription = (model: SessionCreateOptionsResponse['models'][number]) => {
    const copy = { ...model };
    delete copy.description;
    return copy;
  };

  let response = withModels(
    body.models.map((model) => (isPriority(model) ? model : withoutDescription(model))),
  );
  if (serializedBytes(response) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) return response;

  response = withModels(response.models.map(withoutDescription));
  if (serializedBytes(response) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) return response;

  response = withModels(
    response.models.map((model) => {
      if (isPriority(model)) return model;
      const copy = { ...model };
      delete copy.costSummary;
      return copy;
    }),
  );
  if (serializedBytes(response) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) return response;

  const nonPriorityCount = response.models.filter((model) => !isPriority(model)).length;
  const modelsWithNonPriorityLimit = (limit: number) => {
    let included = 0;
    return response.models.filter((model) => {
      if (isPriority(model)) return true;
      if (included >= limit) return false;
      included += 1;
      return true;
    });
  };

  let minimumNonPriority = 0;
  let maximumNonPriority = nonPriorityCount;
  let fitted: SessionCreateOptionsResponse | null = null;
  while (minimumNonPriority <= maximumNonPriority) {
    const count = Math.floor((minimumNonPriority + maximumNonPriority) / 2);
    const candidate = withModels(modelsWithNonPriorityLimit(count));
    if (serializedBytes(candidate) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) {
      fitted = candidate;
      minimumNonPriority = count + 1;
    } else {
      maximumNonPriority = count - 1;
    }
  }
  if (fitted) return fitted;

  response = withModels(modelsWithNonPriorityLimit(0));
  const defaultModels = response.models.filter(isDefault);
  const recentModels = response.models.filter((model) => model.recent && !isDefault(model));
  const modelsWithRecentLimit = (limit: number) => {
    let included = 0;
    return response.models.filter((model) => {
      if (isDefault(model)) return true;
      if (!model.recent || included >= limit) return false;
      included += 1;
      return true;
    });
  };

  let minimumRecent = 0;
  let maximumRecent = recentModels.length;
  let fittedRecent: SessionCreateOptionsResponse | null = null;
  while (minimumRecent <= maximumRecent) {
    const count = Math.floor((minimumRecent + maximumRecent) / 2);
    const candidate = withModels(modelsWithRecentLimit(count));
    if (serializedBytes(candidate) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) {
      fittedRecent = candidate;
      minimumRecent = count + 1;
    } else {
      maximumRecent = count - 1;
    }
  }
  if (fittedRecent) return fittedRecent;

  return withModels(defaultModels);
}

function remapActivitySequences(
  entries: ActivityEntry[],
  map: (sequence: number) => number,
): ActivityEntry[] {
  return entries.map((entry) => ({
    ...entry,
    afterSequence: Math.max(0, map(entry.afterSequence)),
  }));
}

function detailBytes(entry: ActivityEntry): number {
  if (!entry.detail) return 0;
  if (entry.detail.type === 'text') return Buffer.byteLength(entry.detail.text, 'utf8');
  return (
    Buffer.byteLength(entry.detail.path, 'utf8') +
    Buffer.byteLength(entry.detail.oldText ?? '', 'utf8') +
    Buffer.byteLength(entry.detail.newText ?? '', 'utf8')
  );
}

function boundActivityDetail(entries: ActivityEntry[]): ActivityEntry[] {
  const bounded = entries.map((entry) => ({ ...entry }));
  let total = bounded.reduce((sum, entry) => sum + detailBytes(entry), 0);
  for (const entry of bounded) {
    if (total <= MAX_TOTAL_ACTIVITY_DETAIL_BYTES) break;
    if (!entry.detail) continue;
    total -= detailBytes(entry);
    entry.detail = undefined;
    entry.truncated = true;
  }
  return bounded;
}

function withRenumberedMessages(
  response: LocalLoadedSession,
  messages: LocalLoadedSession['messages'],
  truncated: boolean,
  droppedMessages = 0,
): LocalLoadedSession {
  return {
    ...response,
    messages: messages.map((message, index) => ({ ...message, sequence: index + 1 })),
    activity: response.activity
      ? remapActivitySequences(response.activity, (sequence) =>
          Math.min(sequence - droppedMessages, messages.length),
        )
      : response.activity,
    truncated,
  };
}

function stripOldestActivityDetail(entries: ActivityEntry[]): ActivityEntry[] | null {
  const index = entries.findIndex((entry) => entry.detail !== undefined);
  if (index < 0) return null;
  const next = entries.map((entry) => ({ ...entry }));
  next[index]!.detail = undefined;
  next[index]!.truncated = true;
  return next;
}

function fitLoadedSessionResponse(input: LocalLoadedSession): LocalLoadedSession {
  let response = input;
  // Activity detail is bounded per-entry, but the serialized response must fit
  // the phone transport limit; shed activity payload before touching messages.
  while (serializedBytes(response) > MAX_LOCAL_SESSION_RESPONSE_BYTES) {
    if (!response.activity) break;
    const stripped = stripOldestActivityDetail(response.activity);
    if (stripped) {
      response = { ...response, activity: stripped };
      continue;
    }
    if (response.activity.length === 0) break;
    response = { ...response, activity: response.activity.slice(1), truncated: true };
  }
  while (
    serializedBytes(response) > MAX_LOCAL_SESSION_RESPONSE_BYTES &&
    response.messages.length > 1
  ) {
    response = withRenumberedMessages(response, response.messages.slice(1), true, 1);
  }
  if (serializedBytes(response) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) return response;

  const message = response.messages[0];
  if (!message) throw new Error('Local session response exceeded its byte limit');
  const characters = [...message.text];
  let minimumRemoved = 0;
  let maximumRemoved = characters.length;
  let fitted: LocalLoadedSession | null = null;
  while (minimumRemoved <= maximumRemoved) {
    const removed = Math.floor((minimumRemoved + maximumRemoved) / 2);
    const candidate = withRenumberedMessages(
      response,
      [{ ...message, text: characters.slice(removed).join('') }],
      true,
    );
    if (serializedBytes(candidate) <= MAX_LOCAL_SESSION_RESPONSE_BYTES) {
      fitted = candidate;
      maximumRemoved = removed - 1;
    } else {
      minimumRemoved = removed + 1;
    }
  }
  if (!fitted) throw new Error('Local session response exceeded its byte limit');
  return fitted;
}

function fitActivityResponse(
  body: z.infer<typeof localSessionActivitySchema>,
): z.infer<typeof localSessionActivitySchema> {
  let response = body;
  // The reply text is already capped well under the transport limit, so only
  // the turn's activity entries need shedding.
  while (response.turn && serializedBytes(response) > MAX_LOCAL_SESSION_RESPONSE_BYTES) {
    const stripped = stripOldestActivityDetail(response.turn.activity);
    if (stripped) {
      response = { ...response, turn: { ...response.turn, activity: stripped } };
      continue;
    }
    if (response.turn.activity.length === 0) break;
    response = {
      ...response,
      turn: { ...response.turn, activity: response.turn.activity.slice(1) },
    };
  }
  return response;
}

export type ProcessNameResolver = (pid: number) => Promise<string | undefined>;

const OWNER_NAME_CACHE_MS = 15_000;
const OWNER_NAME_CACHE_LIMIT = 256;
const execFileAsync = promisify(execFile);

// Best-effort process name for an external lock holder (e.g. "Devin"). `ps`
// does not exist on Windows; any failure simply omits ownerName. Results are
// cached briefly so polling does not spawn `ps` on every list.
function psProcessNameResolver(): ProcessNameResolver {
  const cache = new Map<number, { name: string | undefined; expiresAt: number }>();
  return async (pid) => {
    const now = Date.now();
    const cached = cache.get(pid);
    if (cached && cached.expiresAt > now) return cached.name;
    let name: string | undefined;
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
        timeout: 2_000,
        maxBuffer: 4_096,
      });
      const resolved = cleanDisplayText(basename(stdout.trim()), 160, '');
      name = resolved === '' ? undefined : resolved;
    } catch {
      name = undefined;
    }
    if (cache.size >= OWNER_NAME_CACHE_LIMIT) cache.clear();
    cache.set(pid, { name, expiresAt: now + OWNER_NAME_CACHE_MS });
    return name;
  };
}

export class BridgeService {
  private readonly bridgeId: string;
  private readonly rates: z.infer<typeof serviceOptionsSchema>;
  private readonly processNameResolver: ProcessNameResolver;
  private listing = false;
  private loading = false;

  constructor(private readonly dependencies: BridgeServiceOptions) {
    this.bridgeId = opaqueIdSchema.parse(dependencies.bridgeId);
    this.processNameResolver = dependencies.processNameResolver ?? psProcessNameResolver();
    this.rates = serviceOptionsSchema.parse({
      peerLimit: dependencies.peerLimit,
      healthLimit: dependencies.healthLimit,
      sessionListLimit: dependencies.sessionListLimit,
      sessionListContinuationLimit: dependencies.sessionListContinuationLimit,
      sessionLoadLimit: dependencies.sessionLoadLimit,
      sessionActivityLimit: dependencies.sessionActivityLimit,
      mutationLimit: dependencies.mutationLimit,
      windowMs: dependencies.windowMs,
    });
  }

  async handle(input: unknown, contextInput: unknown): Promise<BridgeServiceResponse> {
    const contextResult = requestContextSchema.safeParse(contextInput);
    if (!contextResult.success) {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    const context = contextResult.data;
    if (!this.consumeRate(`peer:${context.peerKey}`, this.rates.peerLimit, context.now)) {
      return { status: 429, body: { error: 'rate_limited' } };
    }

    const authorization = authorizeRequest(input, {
      bridgeId: this.bridgeId,
      devices: this.dependencies.devices,
      replayGuard: this.dependencies.replayGuard,
      now: context.now,
    });
    if (!authorization.ok) return publicRejection(authorization);

    const sessionListBody =
      authorization.request.method === 'session.list'
        ? sessionListBodySchema.safeParse(authorization.request.body)
        : undefined;
    const isSessionListContinuation =
      sessionListBody?.success === true && sessionListBody.data.cursor !== undefined;
    const deviceLimit =
      isSessionListContinuation
        ? this.rates.sessionListContinuationLimit
        : authorization.request.method === 'session.list'
          ? this.rates.sessionListLimit
        : authorization.request.method === 'session.load'
          ? this.rates.sessionLoadLimit
          : authorization.request.method === 'session.activity' ||
              authorization.request.method === 'session.elicitation' ||
              authorization.request.method === 'session.permission'
            ? this.rates.sessionActivityLimit
            : authorization.request.method === 'bridge.health' ||
                authorization.request.method === 'bridge.platform' ||
                authorization.request.method === 'bridge.version'
              ? this.rates.healthLimit
              : this.rates.mutationLimit;
    if (
      !this.consumeRate(
        isSessionListContinuation
          ? `device:${authorization.request.device.deviceId}:session.list.continuation`
          : `device:${authorization.request.device.deviceId}:${authorization.request.method}`,
        deviceLimit,
        context.now,
      )
    ) {
      return { status: 429, body: { error: 'rate_limited' } };
    }

    if (authorization.request.method === 'bridge.health') {
      return {
        status: 200,
        body: healthResponseSchema.parse({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          status: 'ready',
          capabilities: {
            sessionList: this.dependencies.sessions.isSessionListSupported(),
            sessionLoad:
              this.dependencies.sessions.isSessionLoadSupported() &&
              authorization.request.device.permissions.includes('session:content:read'),
            sessionPrompt:
              this.dependencies.sessions.isSessionPromptSupported() &&
              authorization.request.device.permissions.includes('session:prompt:send'),
          },
        }),
      };
    }
    if (authorization.request.method === 'bridge.features') {
      const body = bridgeFeaturesBodySchema.parse(authorization.request.body);
      return {
        status: 200,
        body: featuresResponseSchema.parse({
          sessionElicitation: Boolean(
            this.dependencies.sessions.isSessionElicitationSupported?.() &&
            this.dependencies.sessions.getPendingElicitation &&
            this.dependencies.sessions.respondToElicitation,
          ),
          activityTimeline: this.dependencies.sessions.isSessionLoadSupported(),
          ...(body.interaction === true
            ? {
                permissionPrompts: Boolean(
                  this.dependencies.sessions.isSessionPermissionSupported?.() &&
                  this.dependencies.sessions.getPendingPermission &&
                  this.dependencies.sessions.respondToPermission,
                ),
                sessionCancel: Boolean(
                  this.dependencies.sessions.isSessionCancelSupported?.() &&
                  this.dependencies.sessions.cancelSession,
                ),
                autoApprove: Boolean(
                  this.dependencies.sessions.isSessionAutoApproveSupported?.(),
                ),
              }
            : {}),
          ...(body.presentation === true
            ? {
                messageTimestamps: this.dependencies.sessions.isSessionLoadSupported(),
                grants: {
                  viewSessions:
                    authorization.request.device.permissions.includes('session:content:read'),
                  sendPrompts:
                    authorization.request.device.permissions.includes('session:prompt:send'),
                  startSessions: authorization.request.device.permissions.includes('session:create'),
                },
              }
            : {}),
        }),
      };
    }
    if (authorization.request.method === 'bridge.platform') {
      return {
        status: 200,
        body: platformResponseSchema.parse({ platform: this.dependencies.platform }),
      };
    }
    if (authorization.request.method === 'bridge.version') {
      return {
        status: 200,
        body: versionResponseSchema.parse({ version: CONNECTOR_VERSION }),
      };
    }
    if (authorization.request.method === 'device.revoke') {
      try {
        const revoked = await this.dependencies.devices.revoke?.(
          authorization.request.device.deviceId,
        );
        return revoked
          ? { status: 200, body: { revoked: true } }
          : { status: 503, body: { error: 'temporarily_unavailable' } };
      } catch {
        return { status: 503, body: { error: 'temporarily_unavailable' } };
      }
    }
    if (authorization.request.method === 'session.list') {
      return this.listSessions(authorization, context.now);
    }
    if (authorization.request.method === 'session.load') {
      return this.loadSession(authorization, context.now);
    }
    if (authorization.request.method === 'session.activity') {
      return this.sessionActivity(authorization, context.now);
    }
    if (authorization.request.method === 'session.elicitation') {
      return this.sessionElicitation(authorization, context.now);
    }
    if (authorization.request.method === 'session.elicitation.respond') {
      return this.respondToSessionElicitation(authorization, context.now);
    }
    if (authorization.request.method === 'session.permission') {
      return this.sessionPermission(authorization, context.now);
    }
    if (authorization.request.method === 'session.permission.respond') {
      return this.respondToSessionPermission(authorization, context.now);
    }
    if (authorization.request.method === 'session.cancel') {
      return this.cancelSession(authorization, context.now);
    }
    if (authorization.request.method === 'session.prompt') {
      return this.promptSession(authorization, context.now);
    }
    if (authorization.request.method === 'session.create_options') {
      return this.createOptions(authorization, context.now);
    }
    if (authorization.request.method === 'session.create') {
      return this.createSession(authorization, context.now);
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  private consumeRate(key: string, limit: number, now: number): boolean {
    const rule: RateLimitRule = { limit, windowMs: this.rates.windowMs };
    return this.dependencies.rateLimiter.consume(key, rule, now);
  }

  // Opt-in ownership attribution: connector_live means the bridge's own ACP
  // child drives the session, locked_external means another live process holds
  // the lock, free means no live lock. Probe failures omit the field rather
  // than report a guess.
  private async sessionOwnership(sessionId: string): Promise<SessionOwnership | undefined> {
    const sessions = this.dependencies.sessions;
    if (
      !sessions.getSessionLockPid &&
      !sessions.isSessionConnectorOwned &&
      !sessions.getSessionDriverPid
    ) {
      return undefined;
    }
    try {
      if (sessions.isSessionConnectorOwned?.(sessionId) === true) {
        return { owner: 'connector_live' };
      }
      const lockPid = (await sessions.getSessionLockPid?.(sessionId)) ?? null;
      const driverPid = sessions.getSessionDriverPid?.() ?? null;
      if (lockPid !== null && driverPid !== null && lockPid === driverPid) {
        return { owner: 'connector_live' };
      }
      // "free" is only honest when a lock probe actually ran and found no
      // live holder; without one the field is omitted rather than guessed.
      if (lockPid === null) {
        return sessions.getSessionLockPid ? { owner: 'free' } : undefined;
      }
      const ownerName = await this.processNameResolver(lockPid);
      return {
        owner: 'locked_external',
        ...(ownerName === undefined ? {} : { ownerName }),
      };
    } catch {
      return undefined;
    }
  }

  private async listSessions(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (!this.dependencies.sessions.isSessionListSupported()) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    if (this.listing) return { status: 429, body: { error: 'busy' } };
    this.listing = true;
    try {
      const body = sessionListBodySchema.parse(authorization.request.body);
      const interaction = body.interaction === true;
      const includeOwnership = body.ownership === true;
      const page = await this.dependencies.sessions.listSessions(
        body.cursor === undefined ? {} : { cursor: body.cursor },
      );
      const mayReadTitles =
        authorization.request.device.permissions.includes('session:content:read');
      const response = localSessionPageSchema.parse({
        sessions: await Promise.all(
          page.sessions.map(async (session) => {
            const ownership = includeOwnership
              ? await this.sessionOwnership(session.sessionId)
              : undefined;
            return {
              id: this.dependencies.sessionHandles.register(session.sessionId, now),
              origin: 'computer',
              workspaceName: cleanDisplayText(basename(session.cwd), 160, 'Workspace'),
              hasTitle: Boolean(session.title),
              title:
                mayReadTitles && session.title
                  ? cleanDisplayText(session.title, 10_000, 'Untitled session')
                  : undefined,
              updatedAt: session.updatedAt,
              model: session.modelId
                ? { id: session.modelId, name: modelDisplayName(session.modelId) }
                : undefined,
              activity: session.activity
                ? {
                    active: session.activity.active,
                    kind: session.activity.kind,
                    updatedAt: session.activity.updatedAt,
                    ...(interaction && session.activity.awaiting
                      ? { awaiting: session.activity.awaiting }
                      : {}),
                  }
                : undefined,
              ...(ownership ? { owner: ownership.owner } : {}),
              ...(ownership?.ownerName === undefined ? {} : { ownerName: ownership.ownerName }),
            };
          }),
        ),
        nextCursor: page.nextCursor,
      });
      return { status: 200, body: response };
    } catch {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    } finally {
      this.listing = false;
    }
  }

  private async loadSession(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (!this.dependencies.sessions.isSessionLoadSupported()) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionLoadBodySchema.parse(authorization.request.body);
    const interaction = body.interaction === true;
    const includeOwnership = body.ownership === true;
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    if (this.loading) return { status: 429, body: { error: 'busy' } };

    this.loading = true;
    try {
      const loaded = await this.dependencies.sessions.loadSession(rawSessionId);
      const ownership = includeOwnership
        ? await this.sessionOwnership(rawSessionId)
        : undefined;
      if (loaded.sessionId !== rawSessionId) {
        throw new Error('Loaded ACP session did not match the requested session');
      }
      const keptMessages = loaded.messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.text.trim().length > 0);
      const keptOldIndexes = keptMessages.map(({ index }) => index);
      const remappedActivity = loaded.activity
        ? boundActivityDetail(
            remapActivitySequences(loaded.activity, (sequence) => {
              let kept = 0;
              for (const index of keptOldIndexes) {
                if (index < sequence) kept += 1;
                else break;
              }
              return kept;
            }),
        )
        : undefined;
      const responseActivity = remappedActivity
        ? boundActivityDetail(activityForClient(remappedActivity, interaction))
        : undefined;
      const response = localLoadedSessionSchema.parse({
        session: {
          id: body.sessionId,
          origin: 'computer',
          workspaceName: cleanDisplayText(basename(loaded.cwd), 160, 'Workspace'),
          model: loaded.modelId
            ? { id: loaded.modelId, name: modelDisplayName(loaded.modelId) }
            : undefined,
          ...(ownership ? { owner: ownership.owner } : {}),
          ...(ownership?.ownerName === undefined ? {} : { ownerName: ownership.ownerName }),
        },
        messages: keptMessages.map(({ message, index }, sequence) => ({
          sequence: sequence + 1,
          source: message.source,
          text: message.text,
          ...(body.timestamps === true && loaded.messageTimes?.[index] !== undefined
            ? { createdAt: loaded.messageTimes[index] }
            : {}),
        })),
        activity: responseActivity,
        truncated: loaded.truncated,
      });
      return { status: 200, body: fitLoadedSessionResponse(response) };
    } catch {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    } finally {
      this.loading = false;
    }
  }

  private async sessionActivity(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionActivitySupported?.() ||
      !this.dependencies.sessions.getSessionActivity
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionActivityBodySchema.parse(authorization.request.body);
    const interaction = body.interaction === true;
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    try {
      const activity = await this.dependencies.sessions.getSessionActivity(rawSessionId);
      const turn = this.dependencies.sessions.getSessionTurn
        ? await this.dependencies.sessions.getSessionTurn(rawSessionId)
        : null;
      const activityLabel = activity?.label ?? 'Waiting for the next step';
      const label = cleanDisplayText(
        !interaction && activityLabel === 'Waiting for your answer in Terminal'
          ? defaultActivityLabel(activity?.kind ?? 'thinking')
          : activityLabel,
        160,
        'Working',
      );
      const awaiting = activity?.awaiting ?? interactionAwaiting(label);
      return {
        status: 200,
        body: fitActivityResponse(
          localSessionActivitySchema.parse({
            active: activity?.active ?? false,
            kind: activity?.kind ?? 'thinking',
            label,
            updatedAt: activity?.updatedAt ?? now,
            ...(interaction && awaiting ? { awaiting } : {}),
            ...(interaction && activity?.terminalQuestion
              ? { terminalQuestion: activity.terminalQuestion }
              : {}),
            turn: turn
              ? {
                  startedAt: turn.startedAt,
                  reply: turn.reply,
                  activity: boundActivityDetail(activityForClient(turn.activity, interaction)),
                }
              : undefined,
          }),
        ),
      };
    } catch (error) {
      if (error instanceof AcpBusyError) {
        return { status: 409, body: { error: 'conflict' } };
      }
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async sessionElicitation(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionElicitationSupported?.() ||
      !this.dependencies.sessions.getPendingElicitation
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionElicitationBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    try {
      const pending = this.dependencies.sessions.getPendingElicitation(rawSessionId);
      return {
        status: 200,
        body: localSessionElicitationSchema.parse({
          interaction: pending
            ? {
                id: pending.id,
                message: cleanDisplayText(pending.message, 4_000, 'Devin needs your input'),
                title: pending.title
                  ? cleanDisplayText(pending.title, 500, 'Question from Devin')
                  : undefined,
                description: pending.description
                  ? cleanDisplayText(pending.description, 2_000, 'Additional input requested')
                  : undefined,
                fields: pending.fields.map((field) => ({
                  ...field,
                  title: cleanDisplayText(field.title, 500, field.key),
                  description: field.description
                    ? cleanDisplayText(field.description, 2_000, 'Additional input requested')
                    : undefined,
                  options: field.options?.map((option) => ({
                    value: option.value,
                    label: cleanDisplayText(option.label, 500, option.value),
                  })),
                })),
                createdAt: pending.createdAt,
              }
            : null,
        }),
      };
    } catch {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async respondToSessionElicitation(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionElicitationSupported?.() ||
      !this.dependencies.sessions.getPendingElicitation ||
      !this.dependencies.sessions.respondToElicitation
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionElicitationResponseBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    const pending = this.dependencies.sessions.getPendingElicitation(rawSessionId);
    if (!pending || pending.id !== body.interactionId) {
      return { status: 404, body: { error: 'not_found' } };
    }
    try {
      this.dependencies.sessions.respondToElicitation(
        rawSessionId,
        body.interactionId,
        body.action === 'accept'
          ? { action: 'accept', content: body.content }
          : { action: body.action },
      );
      return { status: 200, body: { accepted: true } };
    } catch {
      return { status: 404, body: { error: 'not_found' } };
    }
  }

  private async sessionPermission(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionPermissionSupported?.() ||
      !this.dependencies.sessions.getPendingPermission ||
      !this.dependencies.sessions.respondToPermission
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionPermissionBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    try {
      const permission = this.dependencies.sessions.getPendingPermission(rawSessionId);
      return {
        status: 200,
        body: localSessionPermissionSchema.parse({
          permission: permission
            ? {
                id: permission.id,
                title: cleanDisplayText(permission.title, 200, 'Run a command'),
                toolKind: permission.toolKind,
                command: permission.command,
                paths: permission.paths?.map((path) => cleanDisplayText(path, 4_096, 'Workspace')),
                decisions: [...permission.decisions],
                createdAt: permission.createdAt,
                expiresAt: permission.expiresAt,
              }
            : null,
        }),
      };
    } catch {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async respondToSessionPermission(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionPermissionSupported?.() ||
      !this.dependencies.sessions.getPendingPermission ||
      !this.dependencies.sessions.respondToPermission
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionPermissionResponseBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    const pending = this.dependencies.sessions.getPendingPermission(rawSessionId);
    if (!pending || pending.id !== body.permissionId) {
      return { status: 404, body: { error: 'not_found' } };
    }
    try {
      this.dependencies.sessions.respondToPermission(
        rawSessionId,
        body.permissionId,
        body.decision,
      );
      return { status: 200, body: { accepted: true } };
    } catch {
      return { status: 404, body: { error: 'not_found' } };
    }
  }

  private async promptSession(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (!this.dependencies.sessions.isSessionPromptSupported()) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionPromptBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    try {
      const result = await this.dependencies.sessions.promptSession(
        rawSessionId,
        body.text,
        body.modelId,
        body.autoApprove,
      );
      const continuedSessionId = result?.continuedSessionId;
      return {
        status: 200,
        body: {
          accepted: true,
          ...(continuedSessionId
            ? { sessionId: this.dependencies.sessionHandles.register(continuedSessionId, now) }
            : {}),
        },
      };
    } catch (error) {
      if (error instanceof AcpBusyError) {
        return { status: 409, body: { error: 'conflict' } };
      }
      if (error instanceof AcpAutoApproveUnavailableError) {
        return { status: 409, body: { error: 'auto_approve_unavailable' } };
      }
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async cancelSession(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    if (
      !this.dependencies.sessions.isSessionCancelSupported?.() ||
      !this.dependencies.sessions.cancelSession
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    const body = sessionCancelBodySchema.parse(authorization.request.body);
    const rawSessionId = this.dependencies.sessionHandles.resolve(body.sessionId, now);
    if (!rawSessionId) return { status: 404, body: { error: 'not_found' } };
    try {
      await this.dependencies.sessions.cancelSession(rawSessionId);
      return { status: 200, body: { cancelled: true } };
    } catch (error) {
      if (error instanceof AcpNotRunningError) {
        return { status: 409, body: { error: 'conflict' } };
      }
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async createOptions(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    const bodyResult = sessionCreateOptionsBodySchema.safeParse(authorization.request.body);
    if (!bodyResult.success) {
      return { status: 400, body: { error: 'invalid_request' } };
    }
    const body = bodyResult.data;
    if (
      !this.dependencies.sessions.isSessionCreateSupported?.() ||
      !this.dependencies.sessions.listCreateOptions
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    try {
      const options = await this.dependencies.sessions.listCreateOptions(body.refresh === true);
      const workspaceNames = workspaceDisplayNames(options.workspaces);
      const response = sessionCreateOptionsResponseSchema.parse({
        workspaces: options.workspaces.map((workspace, index) => ({
          id: this.dependencies.workspaceHandles.register(workspace.path, now),
          name: workspaceNames[index] ?? 'Workspace',
        })),
        models: options.models.map((model) => ({
          id: model.id,
          name: cleanDisplayText(model.name ?? modelDisplayName(model.id), 160, 'Default'),
          ...(model.description
            ? { description: cleanDisplayText(model.description, 500, 'Model option') }
            : {}),
          ...(typeof model.supportsImages === 'boolean'
            ? { supportsImages: model.supportsImages }
            : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.costTier ? { costTier: model.costTier } : {}),
          ...(model.costSummary
            ? { costSummary: cleanDisplayText(model.costSummary, 200, 'Cost') }
            : {}),
          recent: model.recent === true,
          recommended: model.recommended === true,
        })),
        defaultModelId: options.defaultModelId ?? null,
        catalogSource: options.catalogSource ?? 'recent',
      });
      return {
        status: 200,
        body: fitCreateOptionsResponse(response),
      };
    } catch {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }

  private async createSession(
    authorization: RequestAuthorization,
    now: number,
  ): Promise<BridgeServiceResponse> {
    const body = sessionCreateBodySchema.parse(authorization.request.body);
    const cwd = this.dependencies.workspaceHandles.resolve(body.workspaceId, now);
    if (!cwd) return { status: 404, body: { error: 'not_found' } };
    if (
      !this.dependencies.sessions.isSessionCreateSupported?.() ||
      !this.dependencies.sessions.listCreateOptions ||
      !this.dependencies.sessions.createSession
    ) {
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
    try {
      const options = await this.dependencies.sessions.listCreateOptions();
      if (!options.workspaces.some((workspace) => workspace.path === cwd)) {
        return { status: 404, body: { error: 'not_found' } };
      }
      const modelId = body.modelId ?? null;
      if (modelId && !options.models.some((model) => model.id === modelId)) {
        return { status: 404, body: { error: 'not_found' } };
      }
      const sessionId = await this.dependencies.sessions.createSession(
        cwd,
        modelId,
        body.text,
        body.autoApprove,
      );
      return {
        status: 200,
        body: {
          accepted: true,
          sessionId: this.dependencies.sessionHandles.register(sessionId, now),
        },
      };
    } catch (error) {
      if (error instanceof AcpAutoApproveUnavailableError) {
        return { status: 409, body: { error: 'auto_approve_unavailable' } };
      }
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    }
  }
}
