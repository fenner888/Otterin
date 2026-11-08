import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
  ActivityLog,
  activityKindFromToolName,
  type ActivityEntry,
} from './activity';
import type {
  AcpActivityKind,
  AcpHistoryMessage,
  AcpLoadedSession,
  AcpTerminalQuestion,
} from './acp';
import { sessionIdSchema } from './schemas';
import { utf8Tail } from './text';

// Schemas 17–19 add auxiliary data without changing the reviewed main-chain reads.
// Deliberately do not traverse those tables or accept arbitrary future versions.
const REVIEWED_SCHEMA_VERSIONS = new Set([16, 17, 18, 19, 20]);
const MAXIMUM_DATABASE_BYTES = 16 * 1024 ** 3;
const MAXIMUM_CHAIN_NODES = 10_000;
const MAXIMUM_MESSAGES = 200;
// Must fit the bridge and phone's 100,000-character per-message contract.
const MAXIMUM_MESSAGE_BYTES = 100_000;
const MAXIMUM_HISTORY_BYTES = 160 * 1024;
const MAXIMUM_CREATE_OPTIONS = 100;
const MAXIMUM_LOCK_BYTES = 32;
const ACTIVITY_RECENT_WINDOW_MS = 60_000;
const MAX_MESSAGE_TIMESTAMP_MS = 8_640_000_000_000_000;

const modelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:+-]+$/);

const sessionRowSchema = z
  .object({
    workingDirectory: z.string().min(1).max(4_096).refine(isAbsolute),
    mainChainId: z.number().int().nonnegative(),
    modelId: z.union([modelIdSchema, z.literal('')]),
  })
  .strict();

const chainRowSchema = z
  .object({
    depth: z.number().int().min(0).max(MAXIMUM_CHAIN_NODES),
    nodeId: z.number().int().nonnegative(),
    chatMessage: z.string().max(2 * 1024 * 1024),
    createdAt: z.unknown(),
  })
  .strict();

const chainBoundarySchema = z
  .object({
    depth: z.number().int().min(0).max(MAXIMUM_CHAIN_NODES),
    parentNodeId: z.number().int().nonnegative().nullable(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    message_id: z.string().max(160).optional(),
    role: z.string().max(40).optional(),
    content: z.unknown().optional(),
    tool_call_id: z.string().max(512).optional(),
    tool_calls: z.array(z.unknown()).max(100).optional(),
    thinking: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const storedToolCallSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(160),
    arguments: z.unknown().optional(),
  })
  .passthrough();

const toolCallStateRowSchema = z
  .object({
    toolCallId: z.string().min(1).max(512),
    toolCallJson: z.string().max(2 * 1024 * 1024).nullable(),
    toolCallUpdateJson: z.string().max(2 * 1024 * 1024).nullable(),
  })
  .strict();

const toolResultMetaSchema = z
  .object({
    success: z.boolean().optional(),
    kind: z.string().max(80).optional(),
  })
  .passthrough();

const toolCallTimingSchema = z
  .object({
    started_at: z.string().max(80).optional(),
    finished_at: z.string().max(80).optional(),
  })
  .passthrough();

const terminalQuestionSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question: z.string().min(1).max(500),
            header: z.string().max(120).optional(),
            options: z.array(z.object({ label: z.string().max(200) }).passthrough()).max(20),
            multiSelect: z.boolean().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(4),
  })
  .passthrough();

const requiredColumns = {
  sessions: new Set([
    'id',
    'working_directory',
    'model',
    'agent_mode',
    'last_activity_at',
    'main_chain_id',
    'hidden',
  ]),
  message_nodes: new Set(['session_id', 'node_id', 'parent_node_id', 'chat_message']),
  refinery_schema_history: new Set(['version']),
} as const;

// Present in reviewed schemas 16–19 but absent from minimal fixtures; enriched
// fields are skipped rather than failing the load when the table is missing.
const optionalColumns = {
  tool_call_state: new Set([
    'session_id',
    'tool_call_id',
    'tool_call_json',
    'tool_call_update_json',
  ]),
} as const;

export interface DevinSessionStoreOptions {
  databasePath: string;
  expectedOwnerUid?: number;
  lockDirectory?: string;
  isProcessAlive?: (pid: number) => boolean;
  openDatabase?: (path: string) => DatabaseSync;
}

interface TableColumnRow {
  name: unknown;
}

export interface DevinSessionPresentation {
  modelId: string;
  agentMode: string;
}

export interface DevinCreateOptions {
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
}

export interface SessionLiveness {
  active: boolean;
  kind?: AcpActivityKind;
  updatedAt: number;
  pendingQuestion?: AcpTerminalQuestion;
}

function terminalQuestionFromArguments(
  input: unknown,
): AcpTerminalQuestion | undefined {
  const parsed = terminalQuestionSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return {
    questions: parsed.data.questions.map((question) => ({
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: question.options.map((option) => option.label),
      multiSelect: question.multiSelect ?? false,
    })),
  };
}

function messageBytes(message: AcpHistoryMessage): number {
  return Buffer.byteLength(message.text, 'utf8');
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

function isoToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unixSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const milliseconds = Math.floor(value * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_MESSAGE_TIMESTAMP_MS
    ? milliseconds
    : undefined;
}

function lastActivityMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Stored in whole seconds by the CLI.
    return Math.floor(value * 1000);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.floor(Number(trimmed) * 1000);
    return Date.parse(trimmed) || 0;
  }
  return 0;
}

function livenessKindForTool(name: string): AcpActivityKind {
  switch (activityKindFromToolName(name)) {
    case 'read':
      return 'reading';
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing';
    case 'execute':
      return 'executing';
    case 'search':
      return 'searching';
    case 'fetch':
      return 'fetching';
    default:
      return 'thinking';
  }
}

function defaultOpenDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 1_000,
    defensive: true,
    limits: {
      length: 2 * 1024 * 1024,
      sqlLength: 64 * 1024,
      column: 64,
      exprDepth: 64,
      compoundSelect: 8,
      vdbeOp: 250_000,
      functionArg: 16,
      attach: 0,
      likePatternLength: 1_024,
      variableNumber: 16,
      triggerDepth: 0,
    },
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ParsedChainNode {
  nodeId: number;
  message: z.infer<typeof chatMessageSchema>;
  createdAt: unknown;
}

interface ToolResultRecord {
  content: string;
  success: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export class DevinSessionStore {
  private readonly databasePath: string;
  private readonly expectedOwnerUid: number | undefined;
  private readonly lockDirectory: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly dbOpener: (path: string) => DatabaseSync;
  private supported = false;

  constructor(options: DevinSessionStoreOptions) {
    this.databasePath = z.string().min(1).max(4_096).refine(isAbsolute).parse(options.databasePath);
    this.expectedOwnerUid = options.expectedOwnerUid ?? process.getuid?.();
    this.lockDirectory =
      options.lockDirectory ?? join(dirname(this.databasePath), 'session_locks');
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.dbOpener = options.openDatabase ?? defaultOpenDatabase;
  }

  isSessionLoadSupported(): boolean {
    return this.supported;
  }

  async start(): Promise<void> {
    await this.validateDatabaseFile();
    const database = this.openDatabase();
    try {
      this.validateSchema(database);
      this.supported = true;
    } finally {
      database.close();
    }
  }

  async stop(): Promise<void> {
    this.supported = false;
  }

  async getSessionPresentation(sessionIdInput: unknown): Promise<DevinSessionPresentation> {
    if (!this.supported) throw new Error('Devin session metadata is unavailable');
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    await this.validateDatabaseFile();
    const database = this.openDatabase();
    try {
      database.exec('PRAGMA query_only = ON; BEGIN;');
      this.validateSchema(database);
      const result = z
        .object({ modelId: modelIdSchema, agentMode: z.string().min(1).max(160) })
        .strict()
        .parse(
          database
            .prepare(
              `SELECT model AS modelId, agent_mode AS agentMode
               FROM sessions WHERE id = ? AND hidden = 0`,
            )
            .get(sessionId),
        );
      database.exec('ROLLBACK;');
      return result;
    } catch {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // The database may have rejected the transaction before it began.
      }
      throw new Error('Devin session metadata is unavailable');
    } finally {
      database.close();
    }
  }

  async listCreateOptions(): Promise<DevinCreateOptions> {
    if (!this.supported) throw new Error('Devin session metadata is unavailable');
    await this.validateDatabaseFile();
    const database = this.openDatabase();
    try {
      database.exec('PRAGMA query_only = ON; BEGIN;');
      this.validateSchema(database);
      const workspaces = database
        .prepare(
          `SELECT working_directory AS path
           FROM sessions
           WHERE hidden = 0
           GROUP BY working_directory
           ORDER BY MAX(last_activity_at) DESC
           LIMIT ?`,
        )
        .all(MAXIMUM_CREATE_OPTIONS)
        .map((row) =>
          z
            .object({ path: z.string().min(1).max(4_096).refine(isAbsolute) })
            .strict()
            .parse(row),
        );
      const models = database
        .prepare(
          `SELECT model AS id
           FROM sessions
           WHERE hidden = 0 AND model <> ''
           GROUP BY model
           ORDER BY MAX(last_activity_at) DESC
           LIMIT ?`,
        )
        .all(MAXIMUM_CREATE_OPTIONS)
        .map((row) => z.object({ id: modelIdSchema }).strict().parse(row));
      database.exec('ROLLBACK;');
      return { workspaces, models };
    } catch {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // The database may have rejected the transaction before it began.
      }
      throw new Error('Devin session metadata is unavailable');
    } finally {
      database.close();
    }
  }

  async loadSession(sessionIdInput: unknown): Promise<AcpLoadedSession> {
    if (!this.supported) throw new Error('Devin session history is unavailable');
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    await this.validateDatabaseFile();
    const database = this.openDatabase();
    try {
      database.exec('PRAGMA query_only = ON; BEGIN;');
      this.validateSchema(database);
      const session = sessionRowSchema.parse(
        database
          .prepare(
            `SELECT working_directory AS workingDirectory, main_chain_id AS mainChainId,
                    model AS modelId
             FROM sessions WHERE id = ?`,
          )
          .get(sessionId),
      );
      const hasMessageCreatedAt = this.hasColumns(
        database,
        'message_nodes',
        new Set(['created_at']),
      );
      const chainSql = `
        WITH RECURSIVE chain(depth, node_id, parent_node_id, chat_message, created_at) AS (
          SELECT
            0,
            node.node_id,
            node.parent_node_id,
            node.chat_message,
            ${hasMessageCreatedAt ? 'node.created_at' : 'NULL'}
          FROM message_nodes AS node
          WHERE node.session_id = ? AND node.node_id = ?
          UNION ALL
          SELECT
            chain.depth + 1,
            parent.node_id,
            parent.parent_node_id,
            parent.chat_message,
            ${hasMessageCreatedAt ? 'parent.created_at' : 'NULL'}
          FROM message_nodes AS parent
          JOIN chain
            ON parent.session_id = ? AND parent.node_id = chain.parent_node_id
          WHERE chain.depth < ?
        )`;
      const rows = database
        .prepare(
          `${chainSql}
           SELECT depth, node_id AS nodeId, chat_message AS chatMessage, created_at AS createdAt
           FROM chain
           ORDER BY depth ASC
           LIMIT ?`,
        )
        .all(sessionId, session.mainChainId, sessionId, MAXIMUM_CHAIN_NODES, MAXIMUM_CHAIN_NODES)
        .map((row) => chainRowSchema.parse(row));
      const boundary = chainBoundarySchema.parse(
        database
          .prepare(
            `${chainSql}
             SELECT depth, parent_node_id AS parentNodeId
             FROM chain ORDER BY depth DESC LIMIT 1`,
          )
          .get(sessionId, session.mainChainId, sessionId, MAXIMUM_CHAIN_NODES),
      );
      const toolCallStates = this.loadToolCallStates(database, sessionId);
      database.exec('ROLLBACK;');

      let truncated = boundary.parentNodeId !== null;
      // Persisted activity carries only recorded timestamps; wall-clock
      // fallbacks would inflate durations on every reload.
      const activity = new ActivityLog({ implicitTimestamps: false });
      const lockAlive = await this.sessionLockAlive(sessionId);

      // Chain rows are newest-first; process oldest-first so messages and
      // activity entries land in chronological order.
      const chronological = [...rows].reverse();
      const seenMessageIds = new Set<string>();
      const textMessages: Array<{ source: 'user' | 'devin'; text: string }> = [];

      // Index tool-result nodes so a tool call can be resolved immediately when
      // its assistant step is visited.
      const toolResults = new Map<string, ToolResultRecord>();
      for (const row of chronological) {
        const parsed = this.parseChatMessage(row.chatMessage);
        if (!parsed) continue;
        if (parsed.role !== 'tool') continue;
        const toolCallId = parsed.tool_call_id;
        if (typeof toolCallId !== 'string' || typeof parsed.content !== 'string') continue;
        const extensions = this.messageExtensions(parsed);
        const meta = toolResultMetaSchema.safeParse(extensions['chisel/tool_result_meta']);
        const timing = toolCallTimingSchema.safeParse(extensions['chisel/tool_call_timing']);
        toolResults.set(toolCallId, {
          content: parsed.content,
          success: !meta.success || meta.data.success !== false,
          ...(timing.success
            ? {
                startedAt: isoToMs(timing.data.started_at),
                finishedAt: isoToMs(timing.data.finished_at),
              }
            : {}),
        });
      }

      const nodes: ParsedChainNode[] = [];
      for (const row of chronological) {
        const parsed = this.parseChatMessage(row.chatMessage);
        if (!parsed) {
          truncated = true;
          activity.markTruncated();
          continue;
        }
        nodes.push({ nodeId: row.nodeId, message: parsed, createdAt: row.createdAt });
      }

      const messageTimes: Array<number | undefined> = [];
      for (const node of nodes) {
        const message = node.message;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        if (message.message_id && seenMessageIds.has(message.message_id)) continue;
        if (message.message_id) seenMessageIds.add(message.message_id);
        if (typeof message.content !== 'string') continue;

        const beforeSequence = textMessages.length;
        const metadata = message.metadata ?? {};
        const thoughtStartedAt = isoToMs(
          typeof metadata.started_generation_at === 'string'
            ? metadata.started_generation_at
            : undefined,
        );
        const assistantIssuedAt = isoToMs(
          typeof metadata.created_at === 'string' ? metadata.created_at : undefined,
        );
        const clipped = utf8Tail(message.content, MAXIMUM_MESSAGE_BYTES);
        truncated ||= clipped.truncated;
        textMessages.push({
          source: message.role === 'user' ? 'user' : 'devin',
          text: clipped.text,
        });
        const metadataTimestamp = isoToMs(
          typeof metadata.created_at === 'string' ? metadata.created_at : undefined,
        );
        messageTimes.push(
          metadataTimestamp !== undefined &&
            metadataTimestamp >= 0 &&
            metadataTimestamp <= MAX_MESSAGE_TIMESTAMP_MS
            ? metadataTimestamp
            : unixSecondsToMs(node.createdAt),
        );

        const thinking = message.thinking;
        if (
          thinking &&
          typeof thinking === 'object' &&
          !Array.isArray(thinking) &&
          typeof (thinking as Record<string, unknown>).thinking === 'string'
        ) {
          // A persisted thinking block is always finished; real timestamps keep
          // the group's duration accurate instead of showing a running thought.
          activity.beginThought(beforeSequence, (thinking as { thinking: string }).thinking, thoughtStartedAt);
          activity.closeThought(assistantIssuedAt ?? thoughtStartedAt);
        }

        const toolCallContent = this.messageExtensions(message)['chisel/tool_call_content'];
        for (const rawCall of message.tool_calls ?? []) {
          const call = storedToolCallSchema.safeParse(rawCall);
          if (!call.success) continue;
          this.recordStoredToolCall(
            activity,
            beforeSequence,
            call.data,
            toolCallContent,
            toolCallStates.get(call.data.id),
            toolResults.get(call.data.id),
            session.workingDirectory,
            lockAlive,
            assistantIssuedAt,
          );
        }
      }

      let totalBytes = textMessages.reduce((total, message) => total + messageBytes(message), 0);
      let droppedMessages = 0;
      while (textMessages.length > MAXIMUM_MESSAGES || totalBytes > MAXIMUM_HISTORY_BYTES) {
        const removed = textMessages.shift();
        if (!removed) break;
        messageTimes.shift();
        totalBytes -= messageBytes(removed);
        droppedMessages += 1;
        truncated = true;
      }
      const entries = activity
        .list()
        .map((entry) => ({
          ...entry,
          afterSequence: Math.max(0, entry.afterSequence - droppedMessages),
        }))
        .filter((entry) => entry.afterSequence <= textMessages.length);

      const loaded = attachActivity(
        {
          sessionId,
          cwd: session.workingDirectory,
          messages: textMessages,
          truncated: truncated || activity.truncated,
          ...(session.modelId ? { modelId: session.modelId } : {}),
        },
        entries,
      );
      return attachMessageTimes(loaded, messageTimes);
    } catch {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // The database may have rejected the transaction before it began.
      }
      throw new Error('Devin session history is unavailable');
    } finally {
      database.close();
    }
  }

  async getSessionLiveness(sessionIdInput: unknown): Promise<SessionLiveness | null> {
    if (!this.supported) return null;
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    // A dead lock answers the question without ever touching SQLite.
    if (!(await this.sessionLockAlive(sessionId))) return null;
    const database = this.openDatabase();
    try {
      database.exec('PRAGMA query_only = ON; BEGIN;');
      const row = database
        .prepare(
          `SELECT last_activity_at AS lastActivityAt
           FROM sessions WHERE id = ? AND hidden = 0`,
        )
        .get(sessionId) as { lastActivityAt?: unknown } | undefined;
      const tip = row
        ? (database
            .prepare(
              `SELECT chat_message AS chatMessage FROM message_nodes
               WHERE session_id = ? ORDER BY row_id DESC LIMIT 1`,
            )
            .get(sessionId) as { chatMessage?: unknown } | undefined)
        : undefined;
      const tipMessage =
        typeof tip?.chatMessage === 'string' ? this.parseChatMessage(tip.chatMessage) : null;
      const pending =
        tipMessage?.role === 'assistant'
          ? (tipMessage.tool_calls ?? [])
              .map((raw) => storedToolCallSchema.safeParse(raw))
              .filter((call) => call.success)
              .map((call) => call.data)
          : [];
      const resolved = new Set<string>();
      if (pending.length > 0) {
        const resolvedRows = database
          .prepare(
            `SELECT chat_message AS chatMessage FROM message_nodes
             WHERE session_id = ? ORDER BY row_id DESC LIMIT ?`,
          )
          .all(sessionId, MAXIMUM_CHAIN_NODES) as Array<{ chatMessage?: unknown }>;
        for (const resolvedRow of resolvedRows) {
          const resolvedMessage =
            typeof resolvedRow.chatMessage === 'string'
              ? this.parseChatMessage(resolvedRow.chatMessage)
              : null;
          if (resolvedMessage?.role === 'tool' && resolvedMessage.tool_call_id) {
            resolved.add(resolvedMessage.tool_call_id);
          }
        }
      }
      database.exec('ROLLBACK;');
      if (!row) return null;
      const updatedAt = lastActivityMs(row.lastActivityAt);
      const message = tipMessage;
      if (!message) {
        return {
          active: updatedAt > 0 && Date.now() - updatedAt <= ACTIVITY_RECENT_WINDOW_MS,
          kind: 'thinking',
          updatedAt,
        };
      }
      if (message.role === 'user' || message.role === 'tool') {
        // A TUI turn abandoned with Ctrl-C leaves a live lock forever; treat a
        // stale tip as inactive rather than reporting it "running" forever.
        if (updatedAt === 0 || Date.now() - updatedAt > 30 * 60_000) {
          return { active: false, updatedAt };
        }
        return { active: true, kind: 'thinking', updatedAt };
      }
      if (message.role === 'assistant') {
        const unresolved = pending.filter((call) => !resolved.has(call.id));
        if (unresolved.length === 0) {
          return { active: false, updatedAt };
        }
        const questionCalls = unresolved.filter((call) => call.name === 'ask_user_question');
        const pendingQuestion =
          questionCalls.length === 1
            ? terminalQuestionFromArguments(questionCalls[0]?.arguments)
            : undefined;
        return {
          active: true,
          kind: livenessKindForTool(unresolved[unresolved.length - 1]?.name ?? ''),
          updatedAt,
          ...(pendingQuestion ? { pendingQuestion } : {}),
        };
      }
      return {
        active: updatedAt > 0 && Date.now() - updatedAt <= ACTIVITY_RECENT_WINDOW_MS,
        kind: 'thinking',
        updatedAt,
      };
    } catch {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // The database may have rejected the transaction before it began.
      }
      return null;
    } finally {
      database.close();
    }
  }

  private recordStoredToolCall(
    activity: ActivityLog,
    afterSequence: number,
    call: { id: string; name: string; arguments?: unknown },
    toolCallContent: unknown,
    toolCallState: { toolCallJson: string | null; toolCallUpdateJson: string | null } | undefined,
    result: ToolResultRecord | undefined,
    cwd: string,
    lockAlive: boolean,
    assistantIssuedAt?: number,
  ): void {
    const extensionInput =
      toolCallContent && typeof toolCallContent === 'object' && !Array.isArray(toolCallContent)
        ? (toolCallContent as Record<string, unknown>)[call.id]
        : undefined;
    let beginInput: unknown;
    if (toolCallState?.toolCallJson) {
      try {
        beginInput = JSON.parse(toolCallState.toolCallJson);
      } catch {
        beginInput = undefined;
      }
    }
    if (beginInput === undefined && extensionInput !== undefined) beginInput = extensionInput;
    if (beginInput === undefined) {
      beginInput = {
        toolCallId: call.id,
        title: call.name,
        kind: activityKindFromToolName(call.name),
        rawInput: call.arguments,
      };
    }
    if (typeof beginInput === 'object' && beginInput !== null) {
      beginInput = { toolCallId: call.id, ...(beginInput as Record<string, unknown>) };
    }
    activity.beginTool(afterSequence, beginInput, cwd, result?.startedAt ?? assistantIssuedAt);
    if (result) {
      activity.updateTool(call.id, {
        status: result.success ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: result.content } }],
      }, result.finishedAt);
      return;
    }
    let stateStatus: string | undefined;
    if (toolCallState?.toolCallUpdateJson) {
      try {
        const update = JSON.parse(toolCallState.toolCallUpdateJson) as { status?: unknown };
        if (typeof update.status === 'string') stateStatus = update.status;
      } catch {
        stateStatus = undefined;
      }
    }
    if (stateStatus === 'completed' || stateStatus === 'failed') {
      activity.updateTool(call.id, { status: stateStatus });
      return;
    }
    if (lockAlive && call.name === 'ask_user_question' && terminalQuestionFromArguments(call.arguments)) {
      activity.updateTool(call.id, { status: 'in_progress' });
      activity.markAwaitingInput(call.id);
      return;
    }
    // Unresolved calls reflect an interrupted turn unless the session lock is
    // held by a live process that is still working on them.
    if (lockAlive) {
      activity.updateTool(call.id, { status: 'in_progress' });
      return;
    }
    activity.interruptTool(call.id);
  }

  private parseChatMessage(raw: string): z.infer<typeof chatMessageSchema> | null {
    try {
      const parsed = chatMessageSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private messageExtensions(
    message: z.infer<typeof chatMessageSchema>,
  ): Record<string, unknown> {
    const extensions = message.metadata?.extensions;
    return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
      ? (extensions as Record<string, unknown>)
      : {};
  }

  private loadToolCallStates(
    database: DatabaseSync,
    sessionId: string,
  ): Map<string, { toolCallJson: string | null; toolCallUpdateJson: string | null }> {
    const states = new Map<
      string,
      { toolCallJson: string | null; toolCallUpdateJson: string | null }
    >();
    if (!this.hasColumns(database, 'tool_call_state', optionalColumns.tool_call_state)) {
      return states;
    }
    const rows = database
      .prepare(
        `SELECT tool_call_id AS toolCallId, tool_call_json AS toolCallJson,
                tool_call_update_json AS toolCallUpdateJson
         FROM tool_call_state WHERE session_id = ?`,
      )
      .all(sessionId);
    for (const row of rows) {
      const parsed = toolCallStateRowSchema.safeParse(row);
      if (parsed.success) {
        states.set(parsed.data.toolCallId, {
          toolCallJson: parsed.data.toolCallJson,
          toolCallUpdateJson: parsed.data.toolCallUpdateJson,
        });
      }
    }
    return states;
  }

  private async sessionLockAlive(sessionId: string): Promise<boolean> {
    try {
      const content = await readFile(join(this.lockDirectory, `${sessionId}.lock`));
      const pid = Number.parseInt(content.subarray(0, MAXIMUM_LOCK_BYTES).toString('utf8'), 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
      return this.isProcessAlive(pid);
    } catch {
      return false;
    }
  }

  private hasColumns(
    database: DatabaseSync,
    table: string,
    expected: ReadonlySet<string>,
  ): boolean {
    const actual = new Set(
      database
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((row) => z.string().parse((row as unknown as TableColumnRow).name)),
    );
    for (const column of expected) {
      if (!actual.has(column)) return false;
    }
    return true;
  }

  private openDatabase(): DatabaseSync {
    return this.dbOpener(this.databasePath);
  }

  private async validateDatabaseFile(): Promise<void> {
    const file = await lstat(this.databasePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('Devin session database path is not trusted');
    }
    if (this.expectedOwnerUid !== undefined && file.uid !== this.expectedOwnerUid) {
      throw new Error('Devin session database owner is not trusted');
    }
    // Node exposes POSIX permissions as a bit mask; reject group/other write access.
    // eslint-disable-next-line no-bitwise
    if ((file.mode & 0o022) !== 0 || file.size < 1 || file.size > MAXIMUM_DATABASE_BYTES) {
      throw new Error('Devin session database permissions or size are not trusted');
    }
  }

  private validateSchema(database: DatabaseSync): void {
    const version = database
      .prepare('SELECT MAX(version) AS version FROM refinery_schema_history')
      .get() as { version?: unknown } | undefined;
    if (typeof version?.version !== 'number' || !REVIEWED_SCHEMA_VERSIONS.has(version.version)) {
      throw new Error('Devin session database schema is not supported');
    }
    for (const [table, expected] of Object.entries(requiredColumns)) {
      if (!this.hasColumns(database, table, expected)) {
        throw new Error('Devin session database schema is not supported');
      }
    }
  }
}
