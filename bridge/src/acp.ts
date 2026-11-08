import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { z, type ZodType } from 'zod';

import { ActivityLog, type ActivityEntry, type ActivityToolKind } from './activity';
import {
  permissionIdSchema,
  sessionIdSchema,
  sessionListBodySchema,
  sessionPermissionDecisionSchema,
  type SessionPermissionDecision,
} from './schemas';
import { utf8Tail } from './text';

const ACP_PROTOCOL_VERSION = 1 as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60_000;
const MAX_JSON_RPC_BYTES = 1024 * 1024;
const MAX_UNMATCHED_MESSAGES = 100;
const MAX_CACHED_SESSIONS = 10_000;
const MAX_REPLAY_NOTIFICATIONS = 10_000;
const MAX_REPLAY_MESSAGES = 200;
const MAX_REPLAY_TEXT_BYTES = 160 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 100_000;
const MAX_MODEL_CATALOG_BYTES = 1024 * 1024;
const MAX_MODEL_OPTIONS = 1_000;
const MODEL_CATALOG_TIMEOUT_MS = 10_000;
const MAX_ELICITATION_FIELDS = 16;
const MAX_ELICITATION_OPTIONS = 100;
const MAX_ELICITATION_TEXT_LENGTH = 10_000;
const SAFE_ENVIRONMENT_KEYS = [
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'Path',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDSURF_API_KEY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;

const acpClientOptionsSchema = z
  .object({
    executablePath: z.string().min(1).max(4096).refine(isAbsolute, 'CLI path must be absolute'),
    requestTimeoutMs: z.number().int().min(50).max(30_000).default(DEFAULT_REQUEST_TIMEOUT_MS),
    promptTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60_000)
      .default(DEFAULT_PROMPT_TIMEOUT_MS),
    permissionTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60_000)
      .default(DEFAULT_PERMISSION_TIMEOUT_MS),
  })
  .strict();

const jsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number().int()]).optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
  })
  .passthrough();

const initializeResultSchema = z
  .object({
    protocolVersion: z.literal(ACP_PROTOCOL_VERSION),
    agentCapabilities: z.record(z.unknown()),
    agentInfo: z
      .object({
        name: z.string().max(160).optional(),
        version: z.string().max(160).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const closeSessionResultSchema = z.object({}).passthrough();

const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute, 'Path must be absolute');

const acpSessionInfoSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    cwd: absolutePathSchema,
    additionalDirectories: z.array(absolutePathSchema).max(64).optional(),
    title: z.string().max(10_000).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

const listSessionsResultSchema = z
  .object({
    sessions: z.array(acpSessionInfoSchema).max(5_000),
    nextCursor: z.string().min(1).max(4096).optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const ids = value.sessions.map((session) => session.sessionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session IDs must be unique' });
    }
  });

const acpSessionModeSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    description: z.string().max(500).optional(),
  })
  .passthrough();

const acpSessionModesSchema = z
  .object({
    currentModeId: z.string().min(1).max(160),
    availableModes: z.array(acpSessionModeSchema).max(100),
  })
  .passthrough();

const loadSessionResultSchema = z.union([
  z.null(),
  z
    .object({
      modes: z.unknown().nullable().optional(),
      configOptions: z.array(z.unknown()).max(1_000).nullable().optional(),
      _meta: z.record(z.unknown()).nullable().optional(),
    })
    .passthrough(),
]);

const newSessionResultSchema = z
  .object({
    sessionId: sessionIdSchema,
    modes: z.unknown().nullable().optional(),
    configOptions: z.array(z.unknown()).max(1_000).nullable().optional(),
    _meta: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const currentModeUpdateSchema = z
  .object({
    sessionUpdate: z.literal('current_mode_update'),
    currentModeId: z.string().min(1).max(160),
  })
  .passthrough();

const setSessionModeResultSchema = z.object({}).strict();

const selectConfigOptionSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    category: z.string().max(80).optional(),
    type: z.literal('select'),
    currentValue: z.string().max(160),
    options: z
      .array(
        z
          .object({
            value: z.string().min(1).max(160),
            name: z.string().min(1).max(160),
            description: z.string().min(1).max(500).optional(),
            _meta: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .max(MAX_MODEL_OPTIONS),
  })
  .passthrough();

const setConfigOptionResultSchema = z
  .object({ configOptions: z.array(z.unknown()).max(1_000) })
  .passthrough();

const devinModelCatalogSchema = z
  .object({
    families: z
      .array(
        z
          .object({
            variants: z
              .array(
                z
                  .object({
                    model_uid: z
                      .string()
                      .min(1)
                      .max(160)
                      .regex(/^[A-Za-z0-9._:+-]+$/),
                    label: z.string().min(1).max(160),
                    description: z.string().min(1).max(500).optional(),
                    is_new: z.boolean().default(false),
                    cost_summary: z.unknown().optional(),
                    cost_tier: z.unknown().optional(),
                  })
                  .passthrough(),
              )
              .max(MAX_MODEL_OPTIONS),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

const promptResponseSchema = z
  .object({
    stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']),
  })
  .passthrough();

const sessionUpdateNotificationSchema = z
  .object({
    sessionId: sessionIdSchema,
    update: z
      .object({
        sessionUpdate: z.string().min(1).max(128),
      })
      .passthrough(),
    _meta: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const textReplayUpdateSchema = z
  .object({
    sessionUpdate: z.enum(['user_message_chunk', 'agent_message_chunk']),
    messageId: z.string().min(1).max(512).nullable().optional(),
    content: z
      .object({
        type: z.literal('text'),
        text: z.string().max(MAX_JSON_RPC_BYTES),
      })
      .passthrough(),
    _meta: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const toolActivityUpdateSchema = z
  .object({
    sessionUpdate: z.enum(['tool_call', 'tool_call_update']),
    toolCallId: z.string().min(1).max(512),
    title: z.string().min(1).max(500).optional(),
    kind: z
      .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])
      .optional(),
    status: z.string().min(1).max(80).optional(),
  })
  .passthrough();

const elicitationOptionSchema = z
  .object({
    const: z.string().max(500),
    title: z.string().min(1).max(500),
  })
  .passthrough();

const commonElicitationPropertyShape = {
  title: z.string().min(1).max(500).nullable().optional(),
  description: z.string().min(1).max(2_000).nullable().optional(),
};

const stringElicitationPropertySchema = z
  .object({
    type: z.literal('string'),
    ...commonElicitationPropertyShape,
    minLength: z.number().int().min(0).max(MAX_ELICITATION_TEXT_LENGTH).nullable().optional(),
    maxLength: z.number().int().min(0).max(MAX_ELICITATION_TEXT_LENGTH).nullable().optional(),
    pattern: z.null().optional(),
    format: z.null().optional(),
    default: z.string().max(MAX_ELICITATION_TEXT_LENGTH).nullable().optional(),
    enum: z.array(z.string().max(500)).min(1).max(MAX_ELICITATION_OPTIONS).nullable().optional(),
    oneOf: z
      .array(elicitationOptionSchema)
      .min(1)
      .max(MAX_ELICITATION_OPTIONS)
      .nullable()
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.enum && value.oneOf) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose enum or oneOf' });
    }
    const values = value.oneOf?.map((option) => option.const) ?? value.enum ?? [];
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Options must be unique' });
    }
    if ((value.minLength ?? 0) > (value.maxLength ?? MAX_ELICITATION_TEXT_LENGTH)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid string bounds' });
    }
  });

const numericElicitationPropertySchema = z
  .object({
    type: z.enum(['number', 'integer']),
    ...commonElicitationPropertyShape,
    minimum: z.number().finite().nullable().optional(),
    maximum: z.number().finite().nullable().optional(),
    default: z.number().finite().nullable().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ((value.minimum ?? -Infinity) > (value.maximum ?? Infinity)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid numeric bounds' });
    }
    if (
      value.type === 'integer' &&
      value.default !== null &&
      value.default !== undefined &&
      !Number.isInteger(value.default)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Integer default must be an integer',
      });
    }
  });

const booleanElicitationPropertySchema = z
  .object({
    type: z.literal('boolean'),
    ...commonElicitationPropertyShape,
    default: z.boolean().nullable().optional(),
  })
  .passthrough();

const multiSelectItemsSchema = z.union([
  z
    .object({
      type: z.literal('string'),
      enum: z.array(z.string().max(500)).min(1).max(MAX_ELICITATION_OPTIONS),
    })
    .passthrough(),
  z
    .object({
      anyOf: z.array(elicitationOptionSchema).min(1).max(MAX_ELICITATION_OPTIONS),
    })
    .passthrough(),
]);

const arrayElicitationPropertySchema = z
  .object({
    type: z.literal('array'),
    ...commonElicitationPropertyShape,
    minItems: z.number().int().min(0).max(MAX_ELICITATION_OPTIONS).nullable().optional(),
    maxItems: z.number().int().min(0).max(MAX_ELICITATION_OPTIONS).nullable().optional(),
    items: multiSelectItemsSchema,
    default: z.array(z.string().max(500)).max(MAX_ELICITATION_OPTIONS).nullable().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ((value.minItems ?? 0) > (value.maxItems ?? MAX_ELICITATION_OPTIONS)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid selection bounds' });
    }
    const values: string[] =
      'enum' in value.items && Array.isArray(value.items.enum)
        ? (value.items.enum as string[])
        : (value.items as { anyOf: Array<{ const: string }> }).anyOf.map((option) => option.const);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Options must be unique' });
    }
  });

const elicitationPropertySchema = z.union([
  stringElicitationPropertySchema,
  numericElicitationPropertySchema,
  booleanElicitationPropertySchema,
  arrayElicitationPropertySchema,
]);

const formElicitationRequestSchema = z
  .object({
    mode: z.literal('form'),
    message: z.string().min(1).max(4_000),
    sessionId: sessionIdSchema,
    toolCallId: z.string().min(1).max(512).nullable().optional(),
    _meta: z.record(z.unknown()).optional(),
    requestedSchema: z
      .object({
        type: z.literal('object').optional(),
        title: z.string().min(1).max(500).nullable().optional(),
        description: z.string().min(1).max(2_000).nullable().optional(),
        properties: z.record(elicitationPropertySchema),
        required: z
          .array(z.string().min(1).max(160))
          .max(MAX_ELICITATION_FIELDS)
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const keys = Object.keys(value.requestedSchema.properties);
    if (keys.length === 0 || keys.length > MAX_ELICITATION_FIELDS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid field count' });
    }
    for (const key of keys) {
      const hasControlCharacter = [...key].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      });
      if ([...key].length > 160 || hasControlCharacter) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid field name' });
      }
    }
    const required = value.requestedSchema.required ?? [];
    if (new Set(required).size !== required.length || required.some((key) => !keys.includes(key))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid required fields' });
    }
  });

export const permissionOptionSchema = z
  .object({
    optionId: z.string().min(1).max(512),
    kind: z.string().max(500).optional(),
    name: z.string().max(500).optional(),
  })
  .passthrough();

const permissionRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    toolCall: z
      .object({
        toolCallId: z.string().min(1).max(512),
        title: z.string().max(500).optional(),
        kind: z.string().max(500).optional(),
        rawInput: z.unknown().optional(),
        _meta: z.record(z.unknown()).optional(),
      })
      .passthrough(),
    options: z.array(permissionOptionSchema).max(100),
  })
  .passthrough();

export type AcpPermissionOption = z.infer<typeof permissionOptionSchema>;

export function mapPermissionOptions(
  options: readonly AcpPermissionOption[],
): Partial<Record<SessionPermissionDecision, string>> {
  const mapped: Partial<Record<SessionPermissionDecision, string>> = {};
  const allowOnce = options.filter((option) => option.kind === 'allow_once');
  if (allowOnce.length === 1 && allowOnce[0]) {
    mapped.allow_once = allowOnce[0].optionId;
  }

  const sessionAllows = options.filter(
    (option) =>
      option.kind === 'allow_always' &&
      (option.optionId === 'allow_session' ||
        (option.name !== undefined && /\bthis session\b/i.test(option.name))),
  );
  const sessionAllow = sessionAllows[0];
  if (sessionAllows.length === 1 && sessionAllow !== undefined) {
    mapped.allow_session = sessionAllow.optionId;
  }

  const rejectOnce = options.filter((option) => option.kind === 'reject_once');
  if (rejectOnce.length === 1 && rejectOnce[0]) {
    mapped.reject_once = rejectOnce[0].optionId;
  }
  return mapped;
}

function stripControlCharacters(value: string, replacement = ''): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        ? replacement
        : character;
    })
    .join('');
}

function cleanPermissionTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = [...stripControlCharacters(value, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 200)
    .join('');
  return cleaned || undefined;
}

function cleanPermissionCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = [...stripControlCharacters(value).trim()]
    .slice(0, 2_000)
    .join('');
  return cleaned || undefined;
}

export type AcpActivityKind =
  'thinking' | 'reading' | 'editing' | 'executing' | 'searching' | 'fetching' | 'responding';

const PERMISSION_TOOL_KINDS: readonly ActivityToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
];

function permissionToolKind(value: string | undefined): ActivityToolKind | undefined {
  return value && PERMISSION_TOOL_KINDS.includes(value as ActivityToolKind)
    ? (value as ActivityToolKind)
    : undefined;
}

export interface AcpSessionActivity {
  kind: AcpActivityKind;
  label: string;
  active: boolean;
  updatedAt: number;
  awaiting?: 'answer' | 'approval';
  terminalQuestion?: AcpTerminalQuestion;
}

interface ActiveAcpSessionActivity extends AcpSessionActivity {
  sessionId: string;
  toolCallId?: string;
}

function activityKindForTool(
  kind: z.infer<typeof toolActivityUpdateSchema>['kind'],
): AcpActivityKind {
  if (kind === 'read') return 'reading';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'editing';
  if (kind === 'execute') return 'executing';
  if (kind === 'search') return 'searching';
  if (kind === 'fetch') return 'fetching';
  return 'thinking';
}

export function defaultActivityLabel(kind: AcpActivityKind): string {
  if (kind === 'reading') return 'Reading project files';
  if (kind === 'editing') return 'Editing files';
  if (kind === 'executing') return 'Running a command';
  if (kind === 'searching') return 'Searching the project';
  if (kind === 'fetching') return 'Fetching information';
  if (kind === 'responding') return 'Writing a response';
  return 'Thinking through the task';
}

export interface AcpClientOptions {
  executablePath: string;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
}

export interface AcpSessionMetadata {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  title?: string;
  updatedAt?: string;
  modelId?: string;
  activity?: {
    active: boolean;
    kind?: AcpActivityKind;
    updatedAt: number;
    awaiting?: 'answer' | 'approval';
  };
}

export interface AcpTerminalQuestion {
  questions: Array<{
    question: string;
    header?: string;
    options: string[];
    multiSelect: boolean;
  }>;
}

export interface AcpSessionPage {
  sessions: AcpSessionMetadata[];
  nextCursor?: string;
}

export interface AcpHistoryMessage {
  source: 'user' | 'devin';
  text: string;
}

export type AcpElicitationFieldType =
  'text' | 'single_select' | 'multi_select' | 'number' | 'integer' | 'boolean';

export interface AcpElicitationOption {
  value: string;
  label: string;
}

export interface AcpElicitationField {
  key: string;
  type: AcpElicitationFieldType;
  title: string;
  description?: string;
  required: boolean;
  options?: AcpElicitationOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  allowOther?: true;
  minItems?: number;
  maxItems?: number;
  defaultValue?: string | number | boolean | string[];
}

export interface AcpPendingElicitation {
  id: string;
  sessionId: string;
  message: string;
  title?: string;
  description?: string;
  fields: AcpElicitationField[];
  createdAt: number;
}

export interface AcpPendingPermission {
  id: string;
  title: string;
  toolKind?: ActivityToolKind;
  command?: string;
  paths?: string[];
  decisions: SessionPermissionDecision[];
  createdAt: number;
  expiresAt: number;
}

export type AcpElicitationContentValue = string | number | boolean | string[];

export type AcpElicitationResponse =
  | { action: 'accept'; content: Record<string, AcpElicitationContentValue> }
  | { action: 'decline' | 'cancel' };

export interface AcpLoadedSession {
  sessionId: string;
  cwd: string;
  messages: AcpHistoryMessage[];
  truncated: boolean;
  modelId?: string;
  // Attached as non-enumerable own properties so the established message
  // shape remains unchanged until a presentation response is requested.
  activity?: ActivityEntry[];
  messageTimes?: Array<number | undefined>;
}

export interface AcpSessionTurn {
  startedAt: number;
  reply: string;
  replyTruncated: boolean;
  activity: ActivityEntry[];
}

function attachActivity<T extends object>(target: T, activity: ActivityEntry[]): T {
  Object.defineProperty(target, 'activity', {
    value: activity,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}

function attachMessageTimes<T extends object>(
  target: T,
  messageTimes: Array<number | undefined>,
): T {
  Object.defineProperty(target, 'messageTimes', {
    value: messageTimes,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}

function acpReplayTimestamp(update: Record<string, unknown>): number | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const value = (meta as Record<string, unknown>)['cognition.ai/timestamp'];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export type AcpModelBadge = 'new' | 'free_promo';
export type AcpModelCostTier = 'low' | 'medium' | 'high' | 'free';

export interface AcpModelOption {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
  badge?: AcpModelBadge;
  costTier?: AcpModelCostTier;
  costSummary?: string;
}

export interface AcpModelCatalog {
  defaultModelId: string;
  models: AcpModelOption[];
}

interface AcpModelSelector {
  configId: string;
  catalog: AcpModelCatalog;
}

export type AcpOperationFailureKind = 'session_in_use' | 'request_failed';

export class AcpOperationError extends Error {
  constructor(
    readonly kind: AcpOperationFailureKind,
    operation: string,
    readonly code: number,
  ) {
    super(`ACP ${operation} failed`);
    this.name = 'AcpOperationError';
  }
}

export class AcpBusyError extends Error {
  constructor() {
    super('ACP is finishing another session operation');
    this.name = 'AcpBusyError';
  }
}

export class AcpAutoApproveUnavailableError extends Error {
  constructor() {
    super('ACP bypass mode is unavailable');
    this.name = 'AcpAutoApproveUnavailableError';
  }
}

export class AcpNotRunningError extends Error {
  constructor() {
    super('ACP session is not running');
    this.name = 'AcpNotRunningError';
  }
}

export function isAcpSessionInUseError(error: unknown): boolean {
  return error instanceof AcpOperationError && error.kind === 'session_in_use';
}

interface CachedSessionMetadata {
  cwd: string;
}

interface AcpSessionModeState {
  currentModeId: string;
  firstReportedModeId: string;
  availableModeIds: Set<string>;
}

interface CollectedReplayMessage extends AcpHistoryMessage {
  messageId?: string;
  createdAt?: number;
}

interface ReplayCollector {
  sessionId: string;
  cwd: string;
  notifications: number;
  messages: CollectedReplayMessage[];
  textBytes: number;
  truncated: boolean;
  accepting: boolean;
  failed: boolean;
  mergeBarrier: boolean;
  activity: ActivityLog;
  lastAt?: number;
}

interface ActiveTurn {
  sessionId: string;
  startedAt: number;
  promptText: string;
  reply: string;
  replyTruncated: boolean;
  activity: ActivityLog;
}

interface PendingRequest {
  operation: string;
  schema: ZodType<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingElicitationRecord {
  rpcId: string | number;
  public: AcpPendingElicitation;
  toolCallId?: string;
}

interface PendingPermissionRecord {
  rpcId: string | number;
  toolCallId: string;
  optionIds: Partial<Record<SessionPermissionDecision, string>>;
  timer: ReturnType<typeof setTimeout>;
  public: AcpPendingPermission;
}

const MAX_TIMED_OUT_SESSIONS = 100;
const MAX_TIMED_OUT_TOOL_CALLS_PER_SESSION = 50;

function enumOptions(
  property: z.infer<typeof elicitationPropertySchema>,
): AcpElicitationOption[] | undefined {
  if (property.type === 'string') {
    if (property.oneOf) {
      return property.oneOf.map((option) => ({ value: option.const, label: option.title }));
    }
    return property.enum?.map((value) => ({ value, label: value }));
  }
  if (property.type !== 'array') return undefined;
  if ('enum' in property.items && Array.isArray(property.items.enum)) {
    return (property.items.enum as string[]).map((value) => ({ value, label: value }));
  }
  return (property.items as { anyOf: Array<{ const: string; title: string }> }).anyOf.map(
    (option) => ({ value: option.const, label: option.title }),
  );
}

function publicField(
  key: string,
  property: z.infer<typeof elicitationPropertySchema>,
  required: boolean,
  allowOther: boolean,
): AcpElicitationField {
  const base = {
    key,
    title: property.title ?? key,
    ...(property.description ? { description: property.description } : {}),
    required,
  };
  if (property.type === 'string') {
    const options = enumOptions(property);
    return {
      ...base,
      type: options ? 'single_select' : 'text',
      ...(options ? { options } : {}),
      ...(options && allowOther ? { allowOther: true as const } : {}),
      ...(property.minLength !== null && property.minLength !== undefined
        ? { minLength: property.minLength }
        : {}),
      ...(property.maxLength !== null && property.maxLength !== undefined
        ? { maxLength: property.maxLength }
        : {}),
      ...(property.default !== null && property.default !== undefined
        ? { defaultValue: property.default }
        : {}),
    };
  }
  if (property.type === 'array') {
    return {
      ...base,
      type: 'multi_select',
      options: enumOptions(property),
      ...(property.minItems !== null && property.minItems !== undefined
        ? { minItems: property.minItems }
        : {}),
      ...(property.maxItems !== null && property.maxItems !== undefined
        ? { maxItems: property.maxItems }
        : {}),
      ...(property.default ? { defaultValue: [...property.default] } : {}),
    };
  }
  if (property.type === 'boolean') {
    return {
      ...base,
      type: 'boolean',
      ...(property.default !== null && property.default !== undefined
        ? { defaultValue: property.default }
        : {}),
    };
  }
  return {
    ...base,
    type: property.type,
    ...(property.minimum !== null && property.minimum !== undefined
      ? { minimum: property.minimum }
      : {}),
    ...(property.maximum !== null && property.maximum !== undefined
      ? { maximum: property.maximum }
      : {}),
    ...(property.default !== null && property.default !== undefined
      ? { defaultValue: property.default }
      : {}),
  };
}

function validateElicitationContent(
  elicitation: AcpPendingElicitation,
  input: unknown,
): Record<string, AcpElicitationContentValue> {
  const content = z.record(z.unknown()).parse(input);
  const fields = new Map(elicitation.fields.map((field) => [field.key, field]));
  if (Object.keys(content).some((key) => !fields.has(key))) {
    throw new Error('Elicitation response contains an unknown field');
  }
  const validated: Record<string, AcpElicitationContentValue> = {};
  for (const field of elicitation.fields) {
    const value = content[field.key];
    if (value === undefined) {
      if (field.required) throw new Error('Elicitation response is missing a required field');
      continue;
    }
    if (field.type === 'text' || field.type === 'single_select') {
      const parsed = z.string().max(MAX_ELICITATION_TEXT_LENGTH).parse(value);
      const isOption = field.options?.some((option) => option.value === parsed) ?? false;
      let accepted = parsed;
      if (field.type === 'single_select' && field.allowOther && field.options && !isOption) {
        accepted = parsed.trim();
        if (!accepted) throw new Error('Elicitation response must not be empty');
        if ([...accepted].length > (field.maxLength ?? 2_000)) {
          throw new Error('Elicitation response is longer than allowed');
        }
      } else {
        if (field.minLength !== undefined && [...parsed].length < field.minLength) {
          throw new Error('Elicitation response is shorter than allowed');
        }
        if (field.maxLength !== undefined && [...parsed].length > field.maxLength) {
          throw new Error('Elicitation response is longer than allowed');
        }
        if (field.options && !isOption) {
          throw new Error('Elicitation response selected an unavailable option');
        }
      }
      validated[field.key] = accepted;
      continue;
    }
    if (field.type === 'multi_select') {
      const parsed = z.array(z.string().max(500)).max(MAX_ELICITATION_OPTIONS).parse(value);
      if (new Set(parsed).size !== parsed.length) {
        throw new Error('Elicitation response contains duplicate selections');
      }
      if (field.minItems !== undefined && parsed.length < field.minItems) {
        throw new Error('Elicitation response has too few selections');
      }
      if (field.maxItems !== undefined && parsed.length > field.maxItems) {
        throw new Error('Elicitation response has too many selections');
      }
      if (
        field.options &&
        parsed.some((item) => !field.options?.some((option) => option.value === item))
      ) {
        throw new Error('Elicitation response selected an unavailable option');
      }
      validated[field.key] = parsed;
      continue;
    }
    if (field.type === 'boolean') {
      validated[field.key] = z.boolean().parse(value);
      continue;
    }
    const parsed = z.number().finite().parse(value);
    if (field.type === 'integer' && !Number.isInteger(parsed)) {
      throw new Error('Elicitation response must be an integer');
    }
    if (field.minimum !== undefined && parsed < field.minimum) {
      throw new Error('Elicitation response is below the minimum');
    }
    if (field.maximum !== undefined && parsed > field.maximum) {
      throw new Error('Elicitation response is above the maximum');
    }
    validated[field.key] = parsed;
  }
  return validated;
}

export function safeAcpChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: source.NODE_ENV ?? 'production',
    NO_COLOR: '1',
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function acpWorkingDirectory(environment: NodeJS.ProcessEnv): string {
  const candidates = [environment.HOME, environment.USERPROFILE];
  const selected = candidates.find((candidate): candidate is string =>
    Boolean(candidate && isAbsolute(candidate)),
  );
  if (!selected) throw new Error('ACP client requires an absolute user directory');
  return selected;
}

function supportsSessionList(agentCapabilities: Record<string, unknown>): boolean {
  const sessionCapabilities = agentCapabilities.sessionCapabilities;
  if (
    !sessionCapabilities ||
    typeof sessionCapabilities !== 'object' ||
    Array.isArray(sessionCapabilities)
  ) {
    return false;
  }
  const list = (sessionCapabilities as Record<string, unknown>).list;
  return Boolean(list) && typeof list === 'object' && !Array.isArray(list);
}

function supportsSessionLoad(agentCapabilities: Record<string, unknown>): boolean {
  return agentCapabilities.loadSession === true;
}

function trustedModelBadge(meta: Record<string, unknown> | undefined): AcpModelBadge | undefined {
  const badge = meta?.['cognition.ai/badge'];
  return badge === 'new' || badge === 'free_promo' ? badge : undefined;
}

function trustedModelCostTier(value: unknown): AcpModelCostTier | undefined {
  return value === 'Low cost'
    ? 'low'
    : value === 'Med cost'
      ? 'medium'
      : value === 'High cost'
        ? 'high'
        : value === 'Free'
          ? 'free'
          : undefined;
}

function trustedModelCostSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 200) : undefined;
}

function parseAcpModelSelector(
  configOptions: unknown[] | null | undefined,
): AcpModelSelector | null {
  const modelConfig = configOptions
    ?.map((option) => selectConfigOptionSchema.safeParse(option))
    .find(
      (option) =>
        option.success && (option.data.category === 'model' || option.data.id === 'model'),
    );
  if (!modelConfig?.success) return null;
  const ids = modelConfig.data.options.map((candidate) => candidate.value);
  if (new Set(ids).size !== ids.length) throw new Error('ACP model catalog contains duplicate IDs');
  if (!ids.includes(modelConfig.data.currentValue)) {
    throw new Error('ACP model catalog default is unavailable');
  }
  return {
    configId: modelConfig.data.id,
    catalog: {
      defaultModelId: modelConfig.data.currentValue,
      models: modelConfig.data.options.map((candidate) => ({
        id: candidate.value,
        name: candidate.name,
        ...(candidate.description ? { description: candidate.description } : {}),
        ...(typeof candidate._meta?.['cognition.ai/supportsImages'] === 'boolean'
          ? { supportsImages: candidate._meta['cognition.ai/supportsImages'] }
          : {}),
        ...(trustedModelBadge(candidate._meta)
          ? { badge: trustedModelBadge(candidate._meta) }
          : {}),
      })),
    },
  };
}

export function parseAcpModelCatalog(
  configOptions: unknown[] | null | undefined,
): AcpModelCatalog | null {
  return parseAcpModelSelector(configOptions)?.catalog ?? null;
}

export function parseDevinCliModelCatalog(
  input: unknown,
  previousDefaultModelId?: string,
): AcpModelCatalog {
  const parsed = devinModelCatalogSchema.parse(input);
  const models = parsed.families.flatMap((family) =>
    family.variants.map((variant) => {
      const costTier = trustedModelCostTier(variant.cost_tier);
      const costSummary = trustedModelCostSummary(variant.cost_summary);
      return {
        id: variant.model_uid,
        name: variant.label,
        ...(variant.description ? { description: variant.description } : {}),
        ...(variant.is_new ? { badge: 'new' as const } : {}),
        ...(costTier ? { costTier } : {}),
        ...(costSummary ? { costSummary } : {}),
      };
    }),
  );
  if (models.length === 0 || models.length > MAX_MODEL_OPTIONS) {
    throw new Error('Devin CLI model catalog has an invalid size');
  }
  const ids = models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Devin CLI model catalog contains duplicate IDs');
  }
  const defaultModelId =
    previousDefaultModelId && ids.includes(previousDefaultModelId)
      ? previousDefaultModelId
      : ids.includes('adaptive')
        ? 'adaptive'
        : ids[0];
  if (!defaultModelId) throw new Error('Devin CLI model catalog has no default');
  return { defaultModelId, models };
}

export async function listDevinCliModelCatalog(
  executablePath: string,
  previousDefaultModelId?: string,
): Promise<AcpModelCatalog> {
  const validatedPath = acpClientOptionsSchema.shape.executablePath.parse(executablePath);
  const environment = safeAcpChildEnvironment();
  const workingDirectory = acpWorkingDirectory(environment);
  return new Promise<AcpModelCatalog>((resolve, reject) => {
    const child = spawn(validatedPath, ['models', 'list', '--format', 'json'], {
      cwd: workingDirectory,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: AcpModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Devin CLI model catalog is unavailable'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Devin CLI model catalog timed out'));
    }, MODEL_CATALOG_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_MODEL_CATALOG_BYTES) {
        child.kill('SIGTERM');
        finish(new Error('Devin CLI model catalog exceeded the size limit'));
        return;
      }
      output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', () => finish(new Error('Devin CLI model catalog could not be started')));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error('Devin CLI model catalog command failed'));
        return;
      }
      try {
        finish(undefined, parseDevinCliModelCatalog(JSON.parse(output), previousDefaultModelId));
      } catch {
        finish(new Error('Devin CLI model catalog failed validation'));
      }
    });
  });
}

function cloneModelCatalog(catalog: AcpModelCatalog): AcpModelCatalog {
  return {
    defaultModelId: catalog.defaultModelId,
    models: catalog.models.map((model) => ({ ...model })),
  };
}

function messageBytes(message: AcpHistoryMessage): number {
  return Buffer.byteLength(message.text, 'utf8');
}

export class AcpSessionClient {
  private readonly options: z.infer<typeof acpClientOptionsSchema>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private nextRequestId = 1;
  private unmatchedMessages = 0;
  private readonly pending = new Map<string | number, PendingRequest>();
  private canListSessions = false;
  private canLoadSessions = false;
  private canEmbedContext = false;
  private canCloseSessions = false;
  private readonly listedSessions = new Map<string, CachedSessionMetadata>();
  private readonly loadedSessions = new Set<string>();
  private readonly lastLoadedMessages = new Map<string, AcpHistoryMessage[]>();
  private readonly sessionModes = new Map<string, AcpSessionModeState>();
  private activeLoad: ReplayCollector | null = null;
  private activePromptSessionId: string | null = null;
  private latestQuestionToolCallId: string | null = null;
  private timedOutToolCallId: string | null = null;
  private activeTurn: ActiveTurn | null = null;
  private activeActivity: ActiveAcpSessionActivity | null = null;
  private readonly pendingElicitations = new Map<string, PendingElicitationRecord>();
  private readonly pendingPermissions = new Map<string, PendingPermissionRecord>();
  private readonly timedOutToolCalls = new Map<string, Set<string>>();
  private creatingContinuation = false;
  private modelCatalog: AcpModelCatalog | null = null;
  private readonly sessionModelSelectors = new Map<string, AcpModelSelector>();

  constructor(options: AcpClientOptions) {
    this.options = acpClientOptionsSchema.parse(options);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('ACP client is already started');
    const environment = safeAcpChildEnvironment();
    const workingDirectory = acpWorkingDirectory(environment);
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.unmatchedMessages = 0;
    this.listedSessions.clear();
    this.loadedSessions.clear();
    this.sessionModes.clear();
    this.activeLoad = null;
    this.activePromptSessionId = null;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    this.activeTurn = null;
    this.activeActivity = null;
    this.pendingElicitations.clear();
    this.timedOutToolCalls.clear();
    this.clearPendingPermissions(false);
    this.creatingContinuation = false;
    this.modelCatalog = null;
    this.sessionModelSelectors.clear();
    this.canListSessions = false;
    this.canLoadSessions = false;
    this.canEmbedContext = false;
    this.canCloseSessions = false;
    const child = spawn(this.options.executablePath, ['acp'], {
      cwd: workingDirectory,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.handleData(child, chunk));
    child.stdin.on('error', () => this.abort(child, new Error('ACP input stream closed')));
    child.on('error', () => this.abort(child, new Error('ACP process could not be started')));
    child.on('close', () => this.handleClose(child));

    try {
      const initialization = await this.request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'devinx-desktop-bridge', version: '1' },
        },
        initializeResultSchema,
        'initialization',
      );
      this.canListSessions = supportsSessionList(initialization.agentCapabilities);
      this.canLoadSessions = supportsSessionLoad(initialization.agentCapabilities);
      this.canEmbedContext =
        (initialization.agentCapabilities.promptCapabilities as Record<string, unknown> | undefined)
          ?.embeddedContext === true;
      this.canCloseSessions = Boolean(
        (
          initialization.agentCapabilities.sessionCapabilities as
            Record<string, unknown> | undefined
        )?.close,
      );
      // Newer devin acp builds require host authentication before session
      // load/prompt. devin-browser resolves the local Devin.app credential
      // non-interactively on machines where it is installed; failure is
      // non-fatal so list still works when no credential exists.
      await this.request('authenticate', { methodId: 'devin-browser' }, z.object({}).passthrough(), 'authentication').catch(() => undefined);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async listSessions(input: unknown = {}): Promise<AcpSessionPage> {
    if (!this.child) throw new Error('ACP client is not started');
    if (!this.canListSessions) throw new Error('ACP agent does not support session listing');
    const request = sessionListBodySchema.parse(input);
    const result = await this.request(
      'session/list',
      request.cursor ? { cursor: request.cursor } : {},
      listSessionsResultSchema,
      'session list',
    );
    const newSessionIds = result.sessions.filter(
      (session) => !this.listedSessions.has(session.sessionId),
    );
    if (this.listedSessions.size + newSessionIds.length > MAX_CACHED_SESSIONS) {
      throw new Error('ACP listed session cache capacity reached');
    }
    for (const session of result.sessions) {
      this.listedSessions.set(session.sessionId, { cwd: session.cwd });
    }
    return {
      sessions: result.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories
          ? [...session.additionalDirectories]
          : undefined,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
      nextCursor: result.nextCursor,
    };
  }

  isSessionListSupported(): boolean {
    return Boolean(this.child) && this.canListSessions;
  }

  isSessionLoadSupported(): boolean {
    return Boolean(this.child) && this.canLoadSessions;
  }

  isSessionPromptSupported(): boolean {
    return Boolean(this.child);
  }

  isSessionCancelSupported(): boolean {
    return Boolean(this.child);
  }

  isSessionAutoApproveSupported(): boolean {
    return Boolean(this.child);
  }

  isSessionActivitySupported(): boolean {
    return Boolean(this.child);
  }

  isSessionElicitationSupported(): boolean {
    return Boolean(this.child);
  }

  isSessionPermissionSupported(): boolean {
    return Boolean(this.child);
  }

  // PID of the spawned `devin acp` child, compared against session lock files
  // to attribute a live lock to this bridge rather than an external driver.
  getSessionDriverPid(): number | null {
    return this.child?.pid ?? null;
  }

  // True while this session has a live bridge-owned prompt turn. The finished
  // turn snapshot in activeTurn is intentionally not evidence of ownership:
  // finishPrompt releases the session lock before retaining the snapshot.
  isSessionConnectorOwned(sessionIdInput: unknown): boolean {
    const parsed = sessionIdSchema.safeParse(sessionIdInput);
    return parsed.success && this.activePromptSessionId === parsed.data;
  }

  async getSessionActivity(sessionIdInput: unknown): Promise<AcpSessionActivity | null> {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    if (this.activeActivity?.sessionId !== sessionId) return null;
    const { kind, label, active, updatedAt } = this.activeActivity;
    return { kind, label, active, updatedAt };
  }

  getSessionTurn(sessionIdInput: unknown): AcpSessionTurn | null {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const turn = this.activeTurn;
    if (!turn || turn.sessionId !== sessionId) return null;
    return {
      startedAt: turn.startedAt,
      reply: turn.reply,
      replyTruncated: turn.replyTruncated,
      activity: turn.activity.list(),
    };
  }

  getActiveTurnSnapshot(sessionIdInput: unknown): AcpLoadedSession | null {
    const parsedSessionId = sessionIdSchema.safeParse(sessionIdInput);
    if (!parsedSessionId.success) return null;
    const sessionId = parsedSessionId.data;
    const activeTurn = this.activeTurn;
    const metadata = this.listedSessions.get(sessionId);
    if (
      this.activePromptSessionId !== sessionId ||
      !metadata ||
      activeTurn?.sessionId !== sessionId
    ) {
      return null;
    }

    const messages = (this.lastLoadedMessages.get(sessionId) ?? []).map((message) => ({
      ...message,
    }));
    const messageTimes: Array<number | undefined> = messages.map(() => undefined);
    if (activeTurn.promptText) {
      messages.push({ source: 'user', text: activeTurn.promptText });
      messageTimes.push(activeTurn.startedAt);
    }
    const loaded = attachActivity(
      {
        sessionId,
        cwd: metadata.cwd,
        messages,
        truncated: false,
        modelId: this.sessionModelSelectors.get(sessionId)?.catalog.defaultModelId,
      },
      [],
    );
    return attachMessageTimes(loaded, messageTimes);
  }

  getPendingElicitation(sessionIdInput: unknown): AcpPendingElicitation | null {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const pending = this.pendingElicitations.get(sessionId)?.public;
    return pending
      ? {
          ...pending,
          fields: pending.fields.map((field) => ({
            ...field,
            options: field.options?.map((option) => ({ ...option })),
            defaultValue: Array.isArray(field.defaultValue)
              ? [...field.defaultValue]
              : field.defaultValue,
          })),
        }
      : null;
  }

  getPendingPermission(sessionIdInput: unknown): AcpPendingPermission | null {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const pending = this.pendingPermissions.get(sessionId)?.public;
    return pending
      ? {
          ...pending,
          decisions: [...pending.decisions],
          ...(pending.paths ? { paths: [...pending.paths] } : {}),
        }
      : null;
  }

  getTimedOutToolCallIds(sessionIdInput: unknown): ReadonlySet<string> {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    return new Set(this.timedOutToolCalls.get(sessionId) ?? []);
  }

  respondToElicitation(
    sessionIdInput: unknown,
    interactionIdInput: unknown,
    responseInput: unknown,
  ): void {
    const child = this.child;
    if (!child) throw new Error('ACP client is not started');
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const interactionId = z
      .string()
      .regex(/^interaction_[A-Za-z0-9_-]{43}$/)
      .parse(interactionIdInput);
    const response = z
      .union([
        z.object({ action: z.literal('accept'), content: z.record(z.unknown()) }).strict(),
        z.object({ action: z.enum(['decline', 'cancel']) }).strict(),
      ])
      .parse(responseInput);
    const pending = this.pendingElicitations.get(sessionId);
    if (!pending || pending.public.id !== interactionId) {
      throw new Error('ACP elicitation is unavailable');
    }
    const result: AcpElicitationResponse =
      response.action === 'accept'
        ? {
            action: 'accept',
            content: validateElicitationContent(pending.public, response.content),
          }
        : { action: response.action };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: pending.rpcId, result })}\n`);
    this.pendingElicitations.delete(sessionId);
    if (pending.toolCallId) this.activeTurn?.activity.resumeTool(pending.toolCallId);
    if (this.activeActivity?.sessionId === sessionId) {
      this.activeActivity = {
        sessionId,
        kind: 'responding',
        label: 'Working on your task',
        active: true,
        updatedAt: Date.now(),
      };
    }
  }

  respondToPermission(
    sessionIdInput: unknown,
    permissionIdInput: unknown,
    decisionInput: unknown,
  ): void {
    const child = this.child;
    if (!child) throw new Error('ACP client is not started');
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const permissionId = permissionIdSchema.parse(permissionIdInput);
    const decision = sessionPermissionDecisionSchema.parse(decisionInput);
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending || pending.public.id !== permissionId) {
      throw new Error('ACP permission is unavailable');
    }
    const optionId = pending.optionIds[decision];
    if (!optionId) throw new Error('ACP permission decision is unavailable');

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(sessionId);
    this.sendAgentResult(child, pending.rpcId, {
      outcome: { outcome: 'selected', optionId },
    });
    if (decision !== 'reject_once') this.activeTurn?.activity.resumeTool(pending.toolCallId);
    if (this.activeActivity?.sessionId === sessionId) {
      this.activeActivity = {
        sessionId,
        kind: 'responding',
        label: 'Working on your task',
        active: true,
        updatedAt: Date.now(),
      };
    }
  }

  isSessionCreateSupported(): boolean {
    return Boolean(this.child);
  }

  async listModelCatalog(forceRefresh = false): Promise<AcpModelCatalog> {
    if (!this.child) throw new Error('ACP client is not started');
    if (this.modelCatalog && !forceRefresh) return cloneModelCatalog(this.modelCatalog);
    const previousCatalog = this.modelCatalog ? cloneModelCatalog(this.modelCatalog) : null;
    if (forceRefresh) this.modelCatalog = null;
    try {
      // Cold starts also need the account catalog: a new user may have no
      // sessions, and model discovery must not acquire desktop session locks.
      try {
        const catalog = await listDevinCliModelCatalog(
          this.options.executablePath,
          previousCatalog?.defaultModelId,
        );
        this.modelCatalog = catalog;
        return cloneModelCatalog(catalog);
      } catch {
        // Older Devin CLI releases fall back to bounded ACP session discovery.
      }
      if (!this.canListSessions || !this.canLoadSessions) {
        throw new Error('ACP agent does not support model discovery');
      }
      if (this.activeLoad || this.activePromptSessionId || this.creatingContinuation) {
        throw new AcpBusyError();
      }
      let cursor: string | undefined;
      let attempts = 0;
      while (attempts < 20) {
        const page = await this.listSessions(cursor ? { cursor } : {});
        for (const session of page.sessions) {
          if (attempts >= 20) break;
          attempts += 1;
          let loaded = false;
          try {
            await this.loadSession(session.sessionId);
            loaded = true;
            if (this.modelCatalog) {
              return cloneModelCatalog(this.modelCatalog);
            }
          } catch (error) {
            if (!isAcpSessionInUseError(error)) continue;
          } finally {
            if (loaded) {
              try {
                await this.releaseSessionOwnership(session.sessionId);
              } catch {
                // Catalog discovery must not fail because best-effort ownership release did.
              }
            }
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      throw new Error('ACP model catalog is unavailable');
    } catch (error) {
      if (forceRefresh) this.modelCatalog = previousCatalog;
      throw error;
    }
  }

  async loadSession(input: unknown): Promise<AcpLoadedSession> {
    if (!this.child) throw new Error('ACP client is not started');
    if (!this.canLoadSessions) throw new Error('ACP agent does not support session loading');
    if (this.activeLoad || this.activePromptSessionId) throw new AcpBusyError();
    const sessionId = sessionIdSchema.parse(input);
    const metadata = this.listedSessions.get(sessionId);
    if (!metadata) throw new Error('ACP session must be listed before loading');

    const collector: ReplayCollector = {
      sessionId,
      cwd: metadata.cwd,
      notifications: 0,
      messages: [],
      textBytes: 0,
      truncated: false,
      accepting: true,
      failed: false,
      mergeBarrier: false,
      activity: new ActivityLog(),
    };
    this.activeLoad = collector;
    try {
      const loadResult = await this.request(
        'session/load',
        { sessionId, cwd: metadata.cwd, mcpServers: [] },
        loadSessionResultSchema,
        'session load',
      );
      this.registerSessionModes(sessionId, loadResult?.modes);
      if (loadResult) {
        const selector = parseAcpModelSelector(loadResult.configOptions);
        if (selector) {
          this.modelCatalog = selector.catalog;
          this.sessionModelSelectors.set(sessionId, selector);
        }
      }
      collector.accepting = false;
      if (collector.failed) throw new Error('ACP session replay failed validation');
      // A loaded session is never mid-turn: close any trailing open thought
      // and mark still-running tools interrupted.
      collector.activity.finishTurn(collector.lastAt);
      this.loadedSessions.add(sessionId);
      const messages = collector.messages.map(({ source, text }) => ({ source, text }));
      this.cacheLastLoadedMessages(sessionId, messages);
      const loaded = attachActivity(
        {
          sessionId,
          cwd: metadata.cwd,
          messages,
          truncated: collector.truncated || collector.activity.truncated,
          modelId: this.sessionModelSelectors.get(sessionId)?.catalog.defaultModelId,
        },
        collector.activity.list(),
      );
      return attachMessageTimes(
        loaded,
        collector.messages.map((message) => message.createdAt),
      );
    } finally {
      if (this.activeLoad === collector) this.activeLoad = null;
    }
  }

  async promptSession(
    sessionIdInput: unknown,
    textInput: unknown,
    modelInput?: unknown,
    autoApprove?: boolean,
  ): Promise<void> {
    if (!this.child) throw new Error('ACP client is not started');
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const text = z.string().trim().min(1).max(100_000).parse(textInput);
    if (!this.loadedSessions.has(sessionId)) {
      throw new Error('ACP session must be loaded before prompting');
    }
    if (modelInput !== undefined) await this.selectSessionModel(sessionId, modelInput);
    if (autoApprove !== undefined) await this.applyAutoApprove(sessionId, autoApprove);
    this.startPrompt(sessionId, [{ type: 'text', text }]);
  }

  async createContinuation(
    cwdInput: unknown,
    contextInput: unknown,
    textInput: unknown,
    modelInput?: unknown,
    autoApprove?: boolean,
  ): Promise<string> {
    if (!this.child) throw new Error('ACP client is not started');
    if (!this.canEmbedContext) throw new Error('ACP agent does not support embedded context');
    const cwd = absolutePathSchema.parse(cwdInput);
    const context = z
      .string()
      .min(1)
      .max(160 * 1024)
      .parse(contextInput);
    const text = z.string().trim().min(1).max(100_000).parse(textInput);
    if (this.activeLoad || this.activePromptSessionId || this.creatingContinuation) {
      throw new AcpBusyError();
    }
    this.creatingContinuation = true;
    try {
      const created = await this.request(
        'session/new',
        { cwd, mcpServers: [] },
        newSessionResultSchema,
        'session creation',
      );
      this.registerSessionModes(created.sessionId, created.modes);
      if (this.listedSessions.size >= MAX_CACHED_SESSIONS) {
        throw new Error('ACP listed session cache capacity reached');
      }
      this.listedSessions.set(created.sessionId, { cwd });
      this.loadedSessions.add(created.sessionId);
      this.cacheLastLoadedMessages(created.sessionId, []);
      const selector = parseAcpModelSelector(created.configOptions);
      if (selector) {
        this.modelCatalog = selector.catalog;
        this.sessionModelSelectors.set(created.sessionId, selector);
      }
      if (modelInput !== undefined) {
        await this.selectSessionModel(created.sessionId, modelInput);
      }
      if (autoApprove !== undefined) {
        await this.applyAutoApprove(created.sessionId, autoApprove);
      }
      this.startPrompt(created.sessionId, [
        {
          type: 'resource',
          resource: {
            uri: 'devinx://continuation/history.md',
            mimeType: 'text/markdown',
            text: context,
          },
        },
        { type: 'text', text },
      ]);
      return created.sessionId;
    } finally {
      this.creatingContinuation = false;
    }
  }

  async createSession(
    cwdInput: unknown,
    modelInput: unknown,
    textInput: unknown,
    autoApprove?: boolean,
  ): Promise<string> {
    if (!this.child) throw new Error('ACP client is not started');
    const cwd = absolutePathSchema.parse(cwdInput);
    const modelId = z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:+-]+$/)
      .nullable()
      .parse(modelInput);
    const text = z.string().trim().min(1).max(100_000).parse(textInput);
    if (this.activeLoad || this.activePromptSessionId || this.creatingContinuation) {
      throw new AcpBusyError();
    }
    this.creatingContinuation = true;
    try {
      const created = await this.request(
        'session/new',
        { cwd, mcpServers: [] },
        newSessionResultSchema,
        'session creation',
      );
      this.registerSessionModes(created.sessionId, created.modes);
      const selector = parseAcpModelSelector(created.configOptions);
      if (selector) {
        this.modelCatalog = selector.catalog;
        this.sessionModelSelectors.set(created.sessionId, selector);
      }
      if (modelId) {
        await this.selectSessionModel(created.sessionId, modelId);
      }
      if (autoApprove !== undefined) {
        await this.applyAutoApprove(created.sessionId, autoApprove);
      }
      if (this.listedSessions.size >= MAX_CACHED_SESSIONS) {
        throw new Error('ACP listed session cache capacity reached');
      }
      this.listedSessions.set(created.sessionId, { cwd });
      this.loadedSessions.add(created.sessionId);
      this.cacheLastLoadedMessages(created.sessionId, []);
      this.startPrompt(created.sessionId, [{ type: 'text', text }]);
      return created.sessionId;
    } finally {
      this.creatingContinuation = false;
    }
  }

  async releaseSessionOwnership(sessionIdInput: unknown): Promise<void> {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    if (!this.loadedSessions.has(sessionId)) return;
    if (!this.child) {
      this.loadedSessions.delete(sessionId);
      this.sessionModelSelectors.delete(sessionId);
      this.sessionModes.delete(sessionId);
      return;
    }
    if (this.canCloseSessions) {
      try {
        await this.request(
          'session/close',
          { sessionId },
          closeSessionResultSchema,
          'session close',
        );
        this.loadedSessions.delete(sessionId);
        this.sessionModelSelectors.delete(sessionId);
        this.sessionModes.delete(sessionId);
        return;
      } catch {
        // A declared but failed close must not leave a Connector-owned lock behind.
      }
    }
    const listedSessions = [...this.listedSessions.entries()];
    const lastLoadedMessages = [...this.lastLoadedMessages.entries()].map(
      ([id, messages]) => [id, messages.map((message) => ({ ...message }))] as const,
    );
    const modelCatalog = this.modelCatalog ? cloneModelCatalog(this.modelCatalog) : null;
    const finishedTurn = this.activeTurn?.sessionId === sessionId ? this.activeTurn : null;
    const timedOutToolCalls = new Map(
      [...this.timedOutToolCalls].map(([id, toolCallIds]) => [id, new Set(toolCallIds)]),
    );
    await this.stop();
    await this.start();
    for (const [id, toolCallIds] of timedOutToolCalls) {
      this.timedOutToolCalls.set(id, toolCallIds);
    }
    for (const [listedSessionId, metadata] of listedSessions) {
      this.listedSessions.set(listedSessionId, { ...metadata });
    }
    for (const [id, messages] of lastLoadedMessages) {
      this.lastLoadedMessages.set(id, messages);
    }
    this.modelCatalog = modelCatalog;
    if (finishedTurn && !this.activeTurn && !this.activePromptSessionId) {
      this.activeTurn = finishedTurn;
    }
  }

  private async selectSessionModel(sessionId: string, modelInput: unknown): Promise<void> {
    const modelId = z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:+-]+$/)
      .parse(modelInput);
    const selector = this.sessionModelSelectors.get(sessionId);
    if (!selector?.catalog.models.some((model) => model.id === modelId)) {
      throw new Error('ACP model is not available');
    }
    const result = await this.request(
      'session/set_config_option',
      { sessionId, configId: selector.configId, value: modelId },
      setConfigOptionResultSchema,
      'model selection',
    );
    const updated = parseAcpModelSelector(result.configOptions);
    if (!updated || updated.catalog.defaultModelId !== modelId) {
      throw new Error('ACP model selection was not confirmed');
    }
    this.sessionModelSelectors.set(sessionId, updated);
    this.modelCatalog = updated.catalog;
  }

  private registerSessionModes(sessionId: string, input: unknown): void {
    const parsed = acpSessionModesSchema.safeParse(input);
    if (!parsed.success) {
      this.sessionModes.delete(sessionId);
      return;
    }
    this.sessionModes.set(sessionId, {
      currentModeId: parsed.data.currentModeId,
      firstReportedModeId: parsed.data.currentModeId,
      availableModeIds: new Set(parsed.data.availableModes.map((mode) => mode.id)),
    });
  }

  private async applyAutoApprove(sessionId: string, enabled: boolean): Promise<void> {
    const modes = this.sessionModes.get(sessionId);
    if (enabled) {
      if (!modes?.availableModeIds.has('bypass')) {
        throw new AcpAutoApproveUnavailableError();
      }
      if (modes.currentModeId !== 'bypass') {
        await this.setSessionMode(sessionId, 'bypass');
      }
      return;
    }
    if (!modes || modes.currentModeId !== 'bypass') return;

    const restoreMode =
      (modes.firstReportedModeId !== 'bypass' &&
      modes.availableModeIds.has(modes.firstReportedModeId)
        ? modes.firstReportedModeId
        : undefined) ??
      (modes.availableModeIds.has('accept-edits')
        ? 'accept-edits'
        : [...modes.availableModeIds].find((modeId) => modeId !== 'bypass'));
    if (!restoreMode) throw new Error('ACP has no non-bypass mode to restore');
    await this.setSessionMode(sessionId, restoreMode);
  }

  private async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.request(
      'session/set_mode',
      { sessionId, modeId },
      setSessionModeResultSchema,
      'mode selection',
    );
    const modes = this.sessionModes.get(sessionId);
    if (modes) modes.currentModeId = modeId;
  }

  cancelSession(sessionIdInput: unknown): void {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const child = this.child;
    if (!child || this.activePromptSessionId !== sessionId) {
      throw new AcpNotRunningError();
    }
    this.clearPendingPermission(sessionId, true);
    this.clearPendingElicitation(sessionId, true);
    if (this.activeTurn?.sessionId === sessionId) {
      this.activeTurn.activity.markCancelRequested();
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`,
    );
  }

  private startPrompt(sessionId: string, prompt: unknown[]): void {
    if (this.activeLoad || this.activePromptSessionId) {
      throw new AcpBusyError();
    }
    const promptText = prompt
      .flatMap((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
        const promptItem = item as Record<string, unknown>;
        return promptItem.type === 'text' && typeof promptItem.text === 'string'
          ? [promptItem.text]
          : [];
      })
      .join('');
    this.activePromptSessionId = sessionId;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    this.activeTurn = {
      sessionId,
      startedAt: Date.now(),
      promptText,
      reply: '',
      replyTruncated: false,
      activity: new ActivityLog(),
    };
    this.activeActivity = {
      sessionId,
      kind: 'thinking',
      label: 'Thinking through your request',
      active: true,
      updatedAt: Date.now(),
    };
    this.request(
      'session/prompt',
      { sessionId, prompt },
      promptResponseSchema,
      'session prompt',
      this.options.promptTimeoutMs,
    ).then(
      () => this.finishPrompt(sessionId),
      () => this.finishPrompt(sessionId),
    );
  }

  private cacheLastLoadedMessages(sessionId: string, messages: AcpHistoryMessage[]): void {
    this.lastLoadedMessages.delete(sessionId);
    this.lastLoadedMessages.set(
      sessionId,
      messages.map((message) => ({ ...message })),
    );
    while (this.lastLoadedMessages.size > MAX_CACHED_SESSIONS) {
      const oldestSessionId = this.lastLoadedMessages.keys().next().value;
      if (oldestSessionId === undefined) break;
      this.lastLoadedMessages.delete(oldestSessionId);
    }
  }

  private async finishPrompt(sessionId: string): Promise<void> {
    if (this.activePromptSessionId !== sessionId) return;
    this.clearPendingElicitation(sessionId, true);
    this.clearPendingPermission(sessionId, true);
    this.activePromptSessionId = null;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    // Keep the turn snapshot readable until the next prompt or a stop() so the
    // phone can still render the completed turn right after end_turn.
    this.activeTurn?.activity.finishTurn();
    await this.releaseSessionOwnership(sessionId).catch(() => this.stop().catch(() => {}));
    if (!this.activePromptSessionId) {
      this.activeActivity = {
        sessionId,
        kind: 'responding',
        label: 'Response ready',
        active: false,
        updatedAt: Date.now(),
      };
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.clearPendingPermissions(true);
    this.child = null;
    this.canListSessions = false;
    this.canLoadSessions = false;
    this.canEmbedContext = false;
    this.canCloseSessions = false;
    this.listedSessions.clear();
    this.loadedSessions.clear();
    this.sessionModes.clear();
    this.sessionModelSelectors.clear();
    this.lastLoadedMessages.clear();
    this.activeLoad = null;
    this.activePromptSessionId = null;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    this.activeTurn = null;
    this.activeActivity = null;
    this.pendingElicitations.clear();
    this.timedOutToolCalls.clear();
    this.creatingContinuation = false;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.unmatchedMessages = 0;
    this.rejectPending(new Error('ACP client stopped'));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      child.once('close', finish);
      child.kill('SIGTERM');
    });
  }

  private request<T>(
    method: string,
    params: unknown,
    schema: ZodType<T>,
    operation: string,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('ACP client is not started'));
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ACP ${operation} timed out`);
        reject(error);
        this.abort(child, error);
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        operation,
        schema: schema as ZodType<unknown>,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private handleData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    this.buffer += this.decoder.write(chunk);
    if (
      Buffer.byteLength(this.buffer, 'utf8') > MAX_JSON_RPC_BYTES &&
      !this.buffer.includes('\n')
    ) {
      this.abort(child, new Error('ACP message exceeded the size limit'));
      return;
    }

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_JSON_RPC_BYTES) {
        this.abort(child, new Error('ACP message exceeded the size limit'));
        return;
      }
      this.handleLine(child, line);
      if (child !== this.child) return;
    }
  }

  private sendAgentResult(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    result: unknown,
  ): void {
    if (child !== this.child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private sendAgentError(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    code: number,
    message: string,
  ): void {
    if (child !== this.child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  private handleAgentRequest(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    method: string,
    params: unknown,
  ): void {
    if (method === 'session/request_permission') {
      const parsed = permissionRequestSchema.safeParse(params);
      if (!parsed.success) {
        this.sendAgentError(child, id, -32602, 'Invalid permission request');
        return;
      }
      const request = parsed.data;
      const optionIds = mapPermissionOptions(request.options);
      if (
        Object.keys(optionIds).length === 0 ||
        request.sessionId !== this.activePromptSessionId ||
        this.pendingPermissions.has(request.sessionId)
      ) {
        this.sendAgentResult(child, id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      const activity = this.activeTurn?.activity.entryForToolCall(request.toolCall.toolCallId);
      const title =
        cleanPermissionTitle(request.toolCall.title) ??
        cleanPermissionTitle(activity?.title) ??
        'Run a command';
      const metadata = request.toolCall._meta;
      const rawInput =
        request.toolCall.rawInput &&
        typeof request.toolCall.rawInput === 'object' &&
        !Array.isArray(request.toolCall.rawInput)
          ? (request.toolCall.rawInput as Record<string, unknown>)
          : undefined;
      const command =
        cleanPermissionCommand(metadata?.['cognition.ai/editableCommand']) ??
        cleanPermissionCommand(rawInput?.command);
      const toolKind = activity?.toolKind ?? permissionToolKind(request.toolCall.kind);
      const createdAt = Date.now();
      const publicPermission: AcpPendingPermission = {
        id: `permission_${randomBytes(32).toString('base64url')}`,
        title,
        ...(toolKind ? { toolKind } : {}),
        ...(command ? { command } : {}),
        ...(activity?.paths ? { paths: [...activity.paths] } : {}),
        decisions: (
          ['allow_once', 'allow_session', 'reject_once'] as const
        ).filter((decision) => optionIds[decision] !== undefined),
        createdAt,
        expiresAt: createdAt + this.options.permissionTimeoutMs,
      };
      const timer = setTimeout(
        () => this.timeOutPermission(request.sessionId, publicPermission.id),
        this.options.permissionTimeoutMs,
      );
      timer.unref();
      this.pendingPermissions.set(request.sessionId, {
        rpcId: id,
        toolCallId: request.toolCall.toolCallId,
        optionIds,
        timer,
        public: publicPermission,
      });
      this.activeTurn?.activity.markAwaitingInput(request.toolCall.toolCallId);
      this.activeActivity = {
        sessionId: request.sessionId,
        toolCallId: request.toolCall.toolCallId,
        kind: 'thinking',
        label: 'Waiting for your approval',
        active: true,
        updatedAt: createdAt,
      };
      return;
    }
    if (method !== 'elicitation/create') {
      this.sendAgentError(child, id, -32601, 'Method not supported');
      return;
    }
    const mode = z
      .object({ mode: z.string(), message: z.string() })
      .passthrough()
      .safeParse(params);
    if (!mode.success) {
      this.sendAgentError(child, id, -32602, 'Invalid elicitation request');
      return;
    }
    if (mode.data.mode !== 'form') {
      this.sendAgentResult(child, id, { action: 'decline' });
      return;
    }
    const parsed = formElicitationRequestSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.activePromptSessionId) {
      this.sendAgentError(child, id, -32602, 'Invalid elicitation request');
      return;
    }
    if (this.pendingElicitations.has(parsed.data.sessionId)) {
      this.sendAgentResult(child, id, { action: 'decline' });
      return;
    }
    const required = new Set(parsed.data.requestedSchema.required ?? []);
    const pending: AcpPendingElicitation = {
      id: `interaction_${randomBytes(32).toString('base64url')}`,
      sessionId: parsed.data.sessionId,
      message: parsed.data.message,
      ...(parsed.data.requestedSchema.title ? { title: parsed.data.requestedSchema.title } : {}),
      ...(parsed.data.requestedSchema.description
        ? { description: parsed.data.requestedSchema.description }
        : {}),
      fields: Object.entries(parsed.data.requestedSchema.properties).map(([key, property]) =>
        publicField(key, property, required.has(key), parsed.data._meta?.['cognition.ai/allowOther'] === true),
      ),
      createdAt: Date.now(),
    };
    const toolCallId = this.latestQuestionToolCallId ?? undefined;
    this.pendingElicitations.set(parsed.data.sessionId, {
      rpcId: id,
      public: pending,
      ...(toolCallId ? { toolCallId } : {}),
    });
    if (toolCallId) this.activeTurn?.activity.markAwaitingInput(toolCallId);
    this.activeActivity = {
      sessionId: parsed.data.sessionId,
      kind: 'thinking',
      label: 'Waiting for your answer',
      active: true,
      updatedAt: pending.createdAt,
    };
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.abort(child, new Error('ACP returned invalid JSON-RPC'));
      return;
    }
    const messageResult = jsonRpcMessageSchema.safeParse(decoded);
    if (!messageResult.success) {
      this.abort(child, new Error('ACP returned invalid JSON-RPC'));
      return;
    }
    const message = messageResult.data;
    if (message.method === 'session/update' && message.id === undefined) {
      this.handleSessionUpdate(child, message.params);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleAgentRequest(child, message.id, message.method, message.params);
      return;
    }
    if (message.id === undefined || !this.pending.has(message.id)) {
      this.unmatchedMessages += 1;
      if (this.unmatchedMessages > MAX_UNMATCHED_MESSAGES) {
        this.abort(child, new Error('ACP returned too many unsolicited messages'));
      }
      return;
    }

    this.unmatchedMessages = 0;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const kind: AcpOperationFailureKind =
        (message.error.code === -32600 || message.error.code === -32015) &&
        /already open in another process/i.test(message.error.message ?? '')
          ? 'session_in_use'
          : 'request_failed';
      pending.reject(new AcpOperationError(kind, pending.operation, message.error.code));
      return;
    }
    const result = pending.schema.safeParse(message.result);
    if (!result.success) {
      const error = new Error(`ACP ${pending.operation} response failed validation`);
      pending.reject(error);
      this.abort(child, error);
      return;
    }
    pending.resolve(result.data);
  }

  private handleSessionUpdate(child: ChildProcessWithoutNullStreams, input: unknown): void {
    const updateNotification = sessionUpdateNotificationSchema.safeParse(input);
    if (
      updateNotification.success &&
      updateNotification.data.update.sessionUpdate === 'current_mode_update'
    ) {
      const modeUpdate = currentModeUpdateSchema.safeParse(updateNotification.data.update);
      if (modeUpdate.success) {
        const modes = this.sessionModes.get(updateNotification.data.sessionId);
        if (modes) modes.currentModeId = modeUpdate.data.currentModeId;
      }
      return;
    }
    const collector = this.activeLoad;
    if (!collector && this.activePromptSessionId) {
      const result = sessionUpdateNotificationSchema.safeParse(input);
      if (!result.success || result.data.sessionId !== this.activePromptSessionId) {
        this.abort(child, new Error('ACP prompt update failed validation'));
        return;
      }
      this.updatePromptActivity(result.data.sessionId, result.data.update);
      return;
    }
    if (!collector || !collector.accepting) {
      this.unmatchedMessages += 1;
      if (this.unmatchedMessages > MAX_UNMATCHED_MESSAGES) {
        this.abort(child, new Error('ACP returned too many unsolicited messages'));
      }
      return;
    }
    collector.notifications += 1;
    if (collector.notifications > MAX_REPLAY_NOTIFICATIONS) {
      collector.truncated = true;
      collector.mergeBarrier = true;
      return;
    }
    const notificationResult = sessionUpdateNotificationSchema.safeParse(input);
    if (!notificationResult.success || notificationResult.data.sessionId !== collector.sessionId) {
      // Drop invalid or differently-associated records without collecting any
      // of their content or terminating otherwise valid replay history.
      collector.truncated = true;
      collector.mergeBarrier = true;
      return;
    }
    const updateType = notificationResult.data.update.sessionUpdate;
    const replayAt = acpReplayTimestamp(notificationResult.data.update);
    if (replayAt !== undefined) collector.lastAt = replayAt;
    if (updateType !== 'user_message_chunk' && updateType !== 'agent_message_chunk') {
      // Devin ACP currently omits messageId on replay. Private thought/tool
      // events still form a trustworthy boundary between otherwise adjacent
      // same-author messages, even though their content must never be exposed.
      this.collectReplayActivity(collector, notificationResult.data.update);
      collector.mergeBarrier = true;
      return;
    }
    const contentType = (notificationResult.data.update.content as { type?: unknown } | undefined)
      ?.type;
    if (contentType !== 'text') {
      collector.mergeBarrier = true;
      return;
    }
    const updateResult = textReplayUpdateSchema.safeParse(notificationResult.data.update);
    if (!updateResult.success) {
      collector.truncated = true;
      collector.mergeBarrier = true;
      return;
    }
    collector.activity.closeThought(replayAt);
    this.collectReplayText(collector, {
      source: updateResult.data.sessionUpdate === 'user_message_chunk' ? 'user' : 'devin',
      text: updateResult.data.content.text,
      messageId: updateResult.data.messageId ?? undefined,
      ...(replayAt !== undefined && replayAt >= 0 && replayAt <= 8_640_000_000_000_000
        ? { createdAt: replayAt }
        : {}),
    });
  }

  private collectReplayActivity(
    collector: ReplayCollector,
    update: Record<string, unknown>,
  ): void {
    const updateType = update.sessionUpdate;
    const at = acpReplayTimestamp(update);
    const afterSequence = collector.messages.length;
    if (updateType === 'agent_thought_chunk') {
      const content = update.content;
      const text =
        content && typeof content === 'object' && !Array.isArray(content)
          ? (content as Record<string, unknown>).text
          : undefined;
      if ((content as { type?: unknown } | undefined)?.type === 'text' && typeof text === 'string') {
        collector.activity.beginThought(afterSequence, text, at);
      }
      return;
    }
    if (updateType === 'tool_call') {
      collector.activity.beginTool(afterSequence, update, collector.cwd, at);
      return;
    }
    if (updateType === 'tool_call_update') {
      const toolCallId = update.toolCallId;
      if (typeof toolCallId === 'string') {
        collector.activity.updateTool(toolCallId, update, at);
      }
    }
  }

  private collectPromptTurn(sessionId: string, update: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn || turn.sessionId !== sessionId) return;
    const updateType = update.sessionUpdate;
    const cwd = this.listedSessions.get(sessionId)?.cwd ?? '/';
    if (updateType === 'agent_message_chunk' || updateType === 'agent_thought_chunk') {
      const content = update.content;
      const text =
        content && typeof content === 'object' && !Array.isArray(content)
          ? (content as Record<string, unknown>).text
          : undefined;
      if ((content as { type?: unknown } | undefined)?.type !== 'text' || typeof text !== 'string') {
        return;
      }
      if (updateType === 'agent_message_chunk') {
        turn.activity.closeThought();
        const merged = utf8Tail(`${turn.reply}${text}`, MAX_MESSAGE_TEXT_BYTES);
        turn.reply = merged.text;
        turn.replyTruncated ||= merged.truncated;
      } else {
        turn.activity.beginThought(0, text);
      }
      return;
    }
    if (updateType === 'tool_call') {
      if (
        update._meta &&
        typeof update._meta === 'object' &&
        !Array.isArray(update._meta) &&
        (update._meta as Record<string, unknown>)['cognition.ai/inferenceToolName'] ===
          'ask_user_question' &&
        typeof update.toolCallId === 'string'
      ) {
        this.latestQuestionToolCallId = update.toolCallId;
      }
      turn.activity.beginTool(0, update, cwd);
      return;
    }
    if (updateType === 'tool_call_update') {
      const toolCallId = update.toolCallId;
      if (typeof toolCallId === 'string') turn.activity.updateTool(toolCallId, update);
    }
  }

  private updatePromptActivity(sessionId: string, update: Record<string, unknown>): void {
    const updateType = update.sessionUpdate;
    this.collectPromptTurn(sessionId, update);
    const pendingPermission = this.pendingPermissions.get(sessionId);
    const pendingElicitation = this.pendingElicitations.get(sessionId);
    const waitingToolCallId = pendingPermission?.toolCallId ?? pendingElicitation?.toolCallId;
    if (waitingToolCallId && update.toolCallId === waitingToolCallId) {
      this.activeTurn?.activity.markAwaitingInput(waitingToolCallId);
      this.activeActivity = {
        sessionId,
        toolCallId: waitingToolCallId,
        kind: 'thinking',
        label: pendingPermission ? 'Waiting for your approval' : 'Waiting for your answer',
        active: true,
        updatedAt: Date.now(),
      };
      return;
    }
    if (pendingPermission || pendingElicitation) return;
    if (
      updateType === 'tool_call_update' &&
      this.timedOutToolCallId !== null &&
      update.toolCallId === this.timedOutToolCallId
    ) {
      return;
    }
    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      const parsed = toolActivityUpdateSchema.safeParse(update);
      if (!parsed.success) return;
      const previous =
        this.activeActivity?.sessionId === sessionId &&
        this.activeActivity.toolCallId === parsed.data.toolCallId
          ? this.activeActivity
          : undefined;
      const status = parsed.data.status?.toLowerCase();
      if (status === 'completed' || status === 'failed') {
        this.activeActivity = {
          sessionId,
          kind: 'thinking',
          label: status === 'failed' ? 'Recovering from a tool error' : 'Checking the next step',
          active: true,
          updatedAt: Date.now(),
        };
        return;
      }
      const kind = parsed.data.kind
        ? activityKindForTool(parsed.data.kind)
        : (previous?.kind ?? 'thinking');
      const title = parsed.data.title?.replace(/\s+/g, ' ').trim();
      this.activeActivity = {
        sessionId,
        toolCallId: parsed.data.toolCallId,
        kind,
        label: title || previous?.label || defaultActivityLabel(kind),
        active: true,
        updatedAt: Date.now(),
      };
      return;
    }
    if (updateType === 'plan' || updateType === 'plan_update') {
      this.activeActivity = {
        sessionId,
        kind: 'thinking',
        label: 'Planning the next steps',
        active: true,
        updatedAt: Date.now(),
      };
      return;
    }
    if (updateType === 'agent_thought_chunk') {
      this.activeActivity = {
        sessionId,
        kind: 'thinking',
        label: 'Thinking through the task',
        active: true,
        updatedAt: Date.now(),
      };
      return;
    }
    if (updateType === 'agent_message_chunk') {
      this.activeActivity = {
        sessionId,
        kind: 'responding',
        label: 'Writing a response',
        active: true,
        updatedAt: Date.now(),
      };
    }
  }

  private collectReplayText(collector: ReplayCollector, input: CollectedReplayMessage): void {
    if (input.text.length === 0) return;
    const clipped = utf8Tail(input.text, MAX_MESSAGE_TEXT_BYTES);
    collector.truncated ||= clipped.truncated;
    const last = collector.messages.at(-1);
    const shouldMerge =
      last?.source === input.source &&
      ((last.messageId !== undefined && last.messageId === input.messageId) ||
        (last.messageId === undefined && input.messageId === undefined && !collector.mergeBarrier));
    if (shouldMerge && last) {
      collector.textBytes -= messageBytes(last);
      const merged = utf8Tail(`${last.text}${clipped.text}`, MAX_MESSAGE_TEXT_BYTES);
      last.text = merged.text;
      collector.truncated ||= merged.truncated;
      collector.textBytes += messageBytes(last);
    } else {
      const message: CollectedReplayMessage = {
        source: input.source,
        text: clipped.text,
        messageId: input.messageId,
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      };
      collector.messages.push(message);
      collector.textBytes += messageBytes(message);
    }
    collector.mergeBarrier = false;
    while (
      collector.messages.length > MAX_REPLAY_MESSAGES ||
      collector.textBytes > MAX_REPLAY_TEXT_BYTES
    ) {
      const removed = collector.messages.shift();
      if (!removed) break;
      collector.textBytes -= messageBytes(removed);
      collector.truncated = true;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearPendingElicitation(sessionId: string, cancel: boolean): void {
    const pending = this.pendingElicitations.get(sessionId);
    if (!pending) return;
    if (cancel && this.child) {
      this.sendAgentResult(this.child, pending.rpcId, { action: 'decline' });
    }
    this.pendingElicitations.delete(sessionId);
  }

  private clearPendingPermission(sessionId: string, cancel: boolean): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (cancel && this.child) {
      this.sendAgentResult(this.child, pending.rpcId, { outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.delete(sessionId);
  }

  private clearPendingPermissions(cancel: boolean): void {
    for (const sessionId of this.pendingPermissions.keys()) {
      this.clearPendingPermission(sessionId, cancel);
    }
  }

  private timeOutPermission(sessionId: string, permissionId: string): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending || pending.public.id !== permissionId) return;
    this.rememberTimedOutToolCall(sessionId, pending.toolCallId);
    this.timedOutToolCallId = pending.toolCallId;
    this.clearPendingPermission(sessionId, true);
    this.activeTurn?.activity.timeOutTool(pending.toolCallId);
    if (this.activePromptSessionId === sessionId) {
      this.activeActivity = {
        sessionId,
        toolCallId: pending.toolCallId,
        kind: 'thinking',
        label: 'Checking the next step',
        active: true,
        updatedAt: Date.now(),
      };
    }
  }

  private rememberTimedOutToolCall(sessionId: string, toolCallId: string): void {
    let toolCallIds = this.timedOutToolCalls.get(sessionId);
    if (!toolCallIds) {
      if (this.timedOutToolCalls.size >= MAX_TIMED_OUT_SESSIONS) {
        const oldestSessionId = this.timedOutToolCalls.keys().next().value;
        if (oldestSessionId !== undefined) this.timedOutToolCalls.delete(oldestSessionId);
      }
      toolCallIds = new Set();
      this.timedOutToolCalls.set(sessionId, toolCallIds);
    }

    toolCallIds.add(toolCallId);
    if (toolCallIds.size > MAX_TIMED_OUT_TOOL_CALLS_PER_SESSION) {
      const oldestToolCallId = toolCallIds.values().next().value;
      if (oldestToolCallId !== undefined) toolCallIds.delete(oldestToolCallId);
    }
  }

  private abort(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.child = null;
    this.canListSessions = false;
    this.canLoadSessions = false;
    this.canEmbedContext = false;
    this.canCloseSessions = false;
    this.listedSessions.clear();
    this.loadedSessions.clear();
    if (this.activeLoad) this.activeLoad.failed = true;
    this.activeLoad = null;
    this.activePromptSessionId = null;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    this.activeTurn = null;
    this.activeActivity = null;
    this.pendingElicitations.clear();
    this.timedOutToolCalls.clear();
    this.clearPendingPermissions(false);
    this.creatingContinuation = false;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.unmatchedMessages = 0;
    this.rejectPending(error);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      forceTimer.unref();
    }
  }

  private handleClose(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    this.child = null;
    this.canListSessions = false;
    this.canLoadSessions = false;
    this.canEmbedContext = false;
    this.canCloseSessions = false;
    this.listedSessions.clear();
    this.loadedSessions.clear();
    if (this.activeLoad) this.activeLoad.failed = true;
    this.activeLoad = null;
    this.activePromptSessionId = null;
    this.latestQuestionToolCallId = null;
    this.timedOutToolCallId = null;
    this.activeTurn = null;
    this.activeActivity = null;
    this.pendingElicitations.clear();
    this.timedOutToolCalls.clear();
    this.clearPendingPermissions(false);
    this.creatingContinuation = false;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.unmatchedMessages = 0;
    this.rejectPending(new Error('ACP process exited'));
  }
}
