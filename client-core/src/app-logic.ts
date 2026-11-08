// Non-React ports of the app-layer bridge logic used by the desktop client:
//  - src/api/bridge/queries.ts: bounded session.list pagination, discovery
//    states, session board loading, load-with-recovery
//  - src/api/bridge/presentation.ts: grant presentation mapping
//  - src/lib/computer-model-catalog.ts: model family/variant grouping
//  - src/app/(main)/computer-session/[bridgeId]/[id].tsx + (main)/index.tsx:
//    error->copy tables, reply-signature settle detection, elicitation summary
//  - src/lib/messageTime.ts + src/lib/session-utils.ts: time labels
//  - src/lib/activity-labels.ts + ActivityGroup grouping/summary helpers
// Device-noun pass: user-facing copy takes a device-name parameter that
// defaults to "This Mac" (see setClientDeviceNoun in ./computerBridge).
import {
  ComputerBridgeError,
  clientDeviceNoun,
  openComputerBridges,
  type ComputerActivityEntry,
  type ComputerActivityStatus,
  type ComputerBridgeConnection,
  type ComputerBridgePresentation,
  type ComputerElicitationAnswer,
  type ComputerElicitationInteraction,
  type ComputerGrants,
  type ComputerLoadedSession,
  type ComputerSessionSummary,
} from './computerBridge';
import type { PairedComputerSummary } from './pairedComputers';

// ---------------------------------------------------------------------------
// Session discovery + board (from src/api/bridge/queries.ts)
// ---------------------------------------------------------------------------

const MAXIMUM_PAGES_PER_COMPUTER = 5;
const MAXIMUM_SESSIONS_PER_COMPUTER = 5_000;
export const computerSessionAccessQueryKey = ['computerSessionAccess'] as const;

export interface ComputerSessionListItem extends ComputerSessionSummary {
  bridgeId: string;
  computerName: string;
  canLoad: boolean;
}

export type ComputerDiscoveryState =
  | 'ready'
  | 'session_discovery_off'
  | 'authorization_failed'
  | 'unavailable'
  | 'invalid_response'
  | 'too_many_sessions'
  | 'busy';

export interface ComputerDiscoveryStatus {
  bridgeId: string;
  computerName: string;
  state: ComputerDiscoveryState;
}

export interface ComputerSessionBoard {
  sessions: ComputerSessionListItem[];
  computers: ComputerDiscoveryStatus[];
  lastSuccessfulAt?: number;
}

export function computerSessionsQueryKey(computers: PairedComputerSummary[]) {
  return ['computerSessions', ...computers.map((computer) => computer.bridgeId).sort()] as const;
}

function stateForError(error: unknown): ComputerDiscoveryState {
  if (!(error instanceof ComputerBridgeError)) return 'unavailable';
  if (
    error.code === 'not_paired' ||
    error.code === 'permission_denied' ||
    error.code === 'authorization_failed'
  ) {
    return 'authorization_failed';
  }
  if (error.code === 'invalid_response') return 'invalid_response';
  if (error.code === 'too_many_sessions') return 'too_many_sessions';
  if (error.code === 'busy' || error.code === 'rate_limited') return 'busy';
  return 'unavailable';
}

export async function discoverComputer(
  computer: PairedComputerSummary,
  bridge: ComputerBridgeConnection,
): Promise<{ sessions: ComputerSessionListItem[]; status: ComputerDiscoveryStatus }> {
  try {
    const health = await bridge.getHealth();
    if (!health.capabilities.sessionList) {
      return {
        sessions: [],
        status: {
          bridgeId: computer.bridgeId,
          computerName: computer.computerName,
          state: 'session_discovery_off',
        },
      };
    }

    const sessions: ComputerSessionListItem[] = [];
    const sessionIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAXIMUM_PAGES_PER_COMPUTER; pageNumber += 1) {
      const page = await bridge.listSessions(cursor ? { cursor } : {});
      for (const session of page.sessions) {
        if (sessionIds.has(session.id) || sessions.length >= MAXIMUM_SESSIONS_PER_COMPUTER) {
          throw new ComputerBridgeError(
            'The paired local device returned an invalid session sequence.',
            'invalid_response',
          );
        }
        sessionIds.add(session.id);
        sessions.push({
          ...session,
          bridgeId: computer.bridgeId,
          computerName: computer.computerName,
          canLoad: health.capabilities.sessionLoad,
        });
      }
      if (!page.nextCursor) break;
      if (pageNumber === MAXIMUM_PAGES_PER_COMPUTER - 1) {
        throw new ComputerBridgeError(
          'The paired local device exceeded the bounded session page limit.',
          'too_many_sessions',
        );
      }
      if (cursors.has(page.nextCursor)) {
        throw new ComputerBridgeError(
          'The paired local device repeated a session cursor.',
          'invalid_response',
        );
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return {
      sessions,
      status: {
        bridgeId: computer.bridgeId,
        computerName: computer.computerName,
        state: 'ready',
      },
    };
  } catch (error) {
    return {
      sessions: [],
      status: {
        bridgeId: computer.bridgeId,
        computerName: computer.computerName,
        state: stateForError(error),
      },
    };
  }
}

function updatedAtMilliseconds(session: ComputerSessionListItem): number {
  if (!session.updatedAt) return 0;
  const parsed = Date.parse(session.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadComputerSessionBoard(
  computers: PairedComputerSummary[],
  previousBoard?: ComputerSessionBoard,
): Promise<ComputerSessionBoard> {
  if (computers.length === 0) return { sessions: [], computers: [] };
  let bridges: Map<string, ComputerBridgeConnection>;
  try {
    bridges = await openComputerBridges(computers.map((computer) => computer.bridgeId));
  } catch (error) {
    return {
      sessions: [],
      computers: computers.map((computer) => ({
        bridgeId: computer.bridgeId,
        computerName: computer.computerName,
        state: stateForError(error),
      })),
      lastSuccessfulAt: previousBoard?.lastSuccessfulAt,
    };
  }
  const results = await Promise.all(
    computers.map((computer) => {
      const bridge = bridges.get(computer.bridgeId);
      if (!bridge) {
        return {
          sessions: [],
          status: {
            bridgeId: computer.bridgeId,
            computerName: computer.computerName,
            state: 'authorization_failed' as const,
          },
        };
      }
      return discoverComputer(computer, bridge);
    }),
  );
  const sessions = results.flatMap((result) => {
    if (result.status.state !== 'unavailable' && result.status.state !== 'busy') {
      return result.sessions;
    }
    return (
      previousBoard?.sessions.filter((session) => session.bridgeId === result.status.bridgeId) ?? []
    );
  });
  const lastSuccessfulAt = results.every(
    ({ status }) => status.state === 'ready' || status.state === 'session_discovery_off',
  )
    ? Date.now()
    : previousBoard?.lastSuccessfulAt;
  return {
    sessions: sessions.sort(
      (left, right) => updatedAtMilliseconds(right) - updatedAtMilliseconds(left),
    ),
    computers: results.map((result) => result.status),
    lastSuccessfulAt,
  };
}

export async function loadComputerSessionWithRecovery(
  computer: PairedComputerSummary,
  sessionId: string,
  options?: { timestamps?: boolean },
): Promise<ComputerLoadedSession> {
  const bridges = await openComputerBridges([computer.bridgeId]);
  const bridge = bridges.get(computer.bridgeId);
  if (!bridge) {
    throw new ComputerBridgeError(
      `${clientDeviceNoun()} is no longer authorized by the paired local device.`,
      'authorization_failed',
    );
  }

  try {
    return await bridge.loadSession(sessionId, options);
  } catch (error) {
    if (!(error instanceof ComputerBridgeError) || error.code !== 'authorization_failed') {
      throw error;
    }

    const recovery = await discoverComputer(computer, bridge);
    const handleWasRehydrated =
      recovery.status.state === 'ready' &&
      recovery.sessions.some((session) => session.id === sessionId && session.canLoad);
    if (!handleWasRehydrated) throw error;
    return bridge.loadSession(sessionId, options);
  }
}

// ---------------------------------------------------------------------------
// Grant presentation mapping (from src/api/bridge/presentation.ts)
// ---------------------------------------------------------------------------

export interface ComputerGrantResolution {
  grants: ComputerGrants;
  source: 'connector' | 'pairing';
}

export function resolveComputerGrants(
  presentation: ComputerBridgePresentation | null | undefined,
  computer: PairedComputerSummary | undefined,
): ComputerGrantResolution | undefined {
  if (presentation) {
    return { grants: presentation.grants, source: 'connector' };
  }
  if (!computer?.permissions) return undefined;
  return {
    grants: {
      viewSessions: computer.permissions.includes('session:content:read'),
      sendPrompts: computer.permissions.includes('session:prompt:send'),
      startSessions: computer.permissions.includes('session:create'),
    },
    source: 'pairing',
  };
}

// ---------------------------------------------------------------------------
// Error -> copy tables (from [id].tsx, index.tsx, ComputerSessionRow.tsx)
// Device-noun pass: hardcoded "This iPhone" became a parameter.
// ---------------------------------------------------------------------------

export function publicErrorMessage(error: unknown, deviceName = clientDeviceNoun()): string {
  if (!(error instanceof ComputerBridgeError)) {
    return 'The local session could not be loaded.';
  }
  if (
    error.code === 'not_paired' ||
    error.code === 'permission_denied' ||
    error.code === 'authorization_failed'
  ) {
    return `${deviceName} does not have permission to read that local session.`;
  }
  if (error.code === 'invalid_response') {
    return 'The paired local device returned an incompatible session history.';
  }
  if (error.code === 'rate_limited') {
    return 'The paired local device is busy. Wait a moment and try again.';
  }
  return 'Open Otterin Connector and confirm the secure local connection is available.';
}

export function promptErrorMessage(
  error: unknown,
  computerName?: string,
  deviceName = clientDeviceNoun(),
): string {
  if (!(error instanceof ComputerBridgeError)) {
    return 'The message could not be sent. Try again.';
  }
  if (error.code === 'busy') {
    return 'Devin is finishing the previous turn. Try again in a moment.';
  }
  if (error.code === 'authorization_failed') {
    return `${deviceName} is no longer authorized. Re-pair this local device in Settings.`;
  }
  if (error.code === 'permission_denied') {
    return `${deviceName} does not have permission to steer this session.`;
  }
  if (error.code === 'rate_limited') {
    return 'Too many requests were sent. Wait a moment and try again.';
  }
  if (error.code === 'unavailable') {
    return 'Otterin Connector is temporarily unavailable. Confirm it is running on your local device.';
  }
  if (error.code === 'auto_approve_unavailable') {
    return `Auto-approve isn't allowed on ${computerName ?? 'your computer'} (organization policy). Your message wasn't sent.`;
  }
  return 'The message could not be sent. Try again.';
}

export function discoveryErrorCopy(status: ComputerDiscoveryStatus): string | null {
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
    return `${status.computerName} is busy. Showing the last session list; pull to refresh again in a moment.`;
  }
  return `${status.computerName} is offline or Otterin Connector is not running.`;
}

export function localOptionsFailureCopy(
  error: unknown,
  deviceName = clientDeviceNoun(),
): { title: string; message: string } {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 'permission_denied' || code === 'authorization_failed' || code === 'not_paired') {
    return {
      title: 'Connector permission required',
      message: `Open Otterin Connector locally and enable Create new sessions for ${deviceName.charAt(0).toLowerCase()}${deviceName.slice(1)}.`,
    };
  }
  return {
    title: 'Local options unavailable',
    message:
      'Otterin Connector could not load workspaces and models. Confirm Connector and Devin for Terminal are ready, then try again.',
  };
}

// ---------------------------------------------------------------------------
// Session-detail helpers (from [id].tsx)
// ---------------------------------------------------------------------------

export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const LOCAL_SESSION_ID_PATTERN = /^local_[A-Za-z0-9_-]{43}$/;
export const MAXIMUM_HISTORY_REFRESH_ATTEMPTS = 39;

export function devinReplySignature(session: ComputerLoadedSession | undefined): string {
  return JSON.stringify(
    session?.messages
      .filter((message) => message.source === 'devin')
      .map((message) => message.text) ?? [],
  );
}

export function hasSettledNewDevinReply(
  baseline: string,
  previouslyObserved: string | null,
  current: string,
): boolean {
  return current !== baseline && current === previouslyObserved;
}

export function elicitationSummary(
  response: ComputerElicitationAnswer,
  interaction: ComputerElicitationInteraction | null | undefined,
): string {
  if (response.action !== 'accept' || !interaction) return 'You skipped this question';
  const values = interaction.fields.flatMap((field) => {
    const value = response.content[field.key];
    if (value === undefined) return [];
    if (Array.isArray(value)) {
      return value.map(
        (item) => field.options?.find((option) => option.value === item)?.label ?? item,
      );
    }
    if (typeof value === 'boolean') return [value ? 'Yes' : 'No'];
    return [field.options?.find((option) => option.value === String(value))?.label ?? String(value)];
  });
  return `You answered · ${values.join(', ') || 'Answered'}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Model catalog (from src/lib/computer-model-catalog.ts, verbatim)
// ---------------------------------------------------------------------------

export type ComputerModelBadge = 'new' | 'free_promo';
export type ComputerModelCostTier = 'low' | 'medium' | 'high' | 'free';

export interface ComputerModelCatalogItem {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
  badge?: ComputerModelBadge;
  costTier?: ComputerModelCostTier;
  costSummary?: string;
  recent?: boolean;
  recommended?: boolean;
}

export interface ComputerModelVariant<T extends ComputerModelCatalogItem = ComputerModelCatalogItem> {
  label: string;
  model: T;
}

export interface ComputerModelFamily<T extends ComputerModelCatalogItem = ComputerModelCatalogItem> {
  key: string;
  name: string;
  description?: string;
  badge?: ComputerModelBadge;
  recent: boolean;
  recommended: boolean;
  variants: ComputerModelVariant<T>[];
}

function normalizeEffort(value: string): string {
  if (value === 'No') return 'None';
  if (value === 'X-High') return 'XHigh';
  return value;
}

export function splitComputerModelName(name: string): { family: string; variant: string } {
  const thinking = name.match(
    /^(.*) (No|Low|Medium|High|XHigh|X-High|Max) Thinking( Fast)?$/,
  );
  if (thinking) {
    return {
      family: thinking[1] ?? name,
      variant: `${normalizeEffort(thinking[2] ?? '')}${thinking[3] ? ' · Fast' : ''}`,
    };
  }

  const contextThinking = name.match(/^(.*?) (No Thinking|High|Max|Thinking) 1M$/);
  if (contextThinking) {
    return {
      family: contextThinking[1] ?? name,
      variant: `${contextThinking[2] === 'No Thinking' ? 'None' : contextThinking[2]} · 1M`,
    };
  }

  const contextOnly = name.match(/^(.*) 1M$/);
  if (contextOnly) return { family: contextOnly[1] ?? name, variant: '1M' };

  const thinkingOnly = name.match(/^(.*) Thinking$/);
  if (thinkingOnly) return { family: thinkingOnly[1] ?? name, variant: 'Thinking' };

  const speed = name.match(/^(SWE-[0-9]+(?:\.[0-9]+)?) (Fast|Lightning)$/);
  if (speed) return { family: speed[1] ?? name, variant: speed[2] ?? 'Fast' };

  const effort = name.match(/^(.*) (Minimal|Low|Medium|High|XHigh|X-High|Max)( Fast)?$/);
  if (effort) {
    return {
      family: effort[1] ?? name,
      variant: `${normalizeEffort(effort[2] ?? '')}${effort[3] ? ' · Fast' : ''}`,
    };
  }

  return { family: name, variant: 'Default' };
}

function familyBadge(models: ComputerModelCatalogItem[]): ComputerModelBadge | undefined {
  if (models.some((model) => model.badge === 'free_promo')) return 'free_promo';
  if (models.some((model) => model.badge === 'new')) return 'new';
  return undefined;
}

export function groupComputerModels<T extends ComputerModelCatalogItem>(
  models: T[],
): ComputerModelFamily<T>[] {
  const families = new Map<string, ComputerModelFamily<T>>();
  for (const model of models) {
    const presentation = splitComputerModelName(model.name);
    const existing = families.get(presentation.family);
    if (existing) {
      existing.variants.push({ label: presentation.variant, model });
      existing.recent ||= model.recent === true;
      existing.recommended ||= model.recommended === true;
      if (!existing.description && model.description) existing.description = model.description;
      existing.badge = familyBadge(existing.variants.map((variant) => variant.model));
      continue;
    }
    families.set(presentation.family, {
      key: presentation.family,
      name: presentation.family,
      ...(model.description ? { description: model.description } : {}),
      ...(model.badge ? { badge: model.badge } : {}),
      recent: model.recent === true,
      recommended: model.recommended === true,
      variants: [{ label: presentation.variant, model }],
    });
  }
  return [...families.values()];
}

export function familyForModelId<T extends ComputerModelCatalogItem>(
  families: ComputerModelFamily<T>[],
  modelId: string | null | undefined,
): ComputerModelFamily<T> | undefined {
  if (!modelId) return families.find((family) => family.recommended);
  return families.find((family) => family.variants.some((variant) => variant.model.id === modelId));
}

export function preferredFamilyVariant<T extends ComputerModelCatalogItem>(
  family: ComputerModelFamily<T>,
  currentModelId?: string | null,
): ComputerModelVariant<T> {
  return (
    family.variants.find((variant) => variant.model.id === currentModelId) ??
    family.variants.find((variant) => variant.model.recommended) ??
    family.variants.find((variant) => variant.model.recent) ??
    family.variants[0]
  ) as ComputerModelVariant<T>;
}

// ---------------------------------------------------------------------------
// Activity labels + grouping (from src/lib/activity-labels.ts and
// src/components/sessions/ActivityGroup.tsx). Status strings are the
// statusLabels vocabulary from src/theme/tokens.ts, inlined so client-core
// stays free of the theme import.
// ---------------------------------------------------------------------------

export type ComputerActivityKindName =
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'executing'
  | 'searching'
  | 'fetching'
  | 'responding';

const ACTIVITY_SHORT_LABELS: Record<ComputerActivityKindName, string> = {
  thinking: 'Thinking',
  reading: 'Reading files',
  editing: 'Editing files',
  executing: 'Running a command',
  searching: 'Searching',
  fetching: 'Fetching',
  responding: 'Responding',
};

export function activityShortLabel(kind: ComputerActivityKindName): string {
  return ACTIVITY_SHORT_LABELS[kind] ?? ACTIVITY_SHORT_LABELS.thinking;
}

// Verbatim subset of statusLabels (src/theme/tokens.ts) covering the
// ComputerActivityStatus vocabulary; the fallback mirrors statusLabels.unknown.
const ACTIVITY_STATUS_LABELS: Record<ComputerActivityStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'Unknown',
  awaiting_input: 'Waiting for your answer',
  timed_out: 'Timed out',
};

export function activityStatusLabel(status: ComputerActivityStatus): string {
  return ACTIVITY_STATUS_LABELS[status] ?? ACTIVITY_STATUS_LABELS.unknown;
}

export function groupActivity(entries: ComputerActivityEntry[]): Map<number, ComputerActivityEntry[]> {
  const groups = new Map<number, ComputerActivityEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.afterSequence);
    if (bucket) bucket.push(entry);
    else groups.set(entry.afterSequence, [entry]);
  }
  return groups;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${pluralForm ?? `${singular}s`}`;
}

export function summarizeActivity(entries: ComputerActivityEntry[]): string {
  const parts: string[] = [];
  if (entries.some((entry) => entry.kind === 'thought')) parts.push('Thought');
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue;
    const kind = entry.toolKind ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const read = counts.get('read') ?? 0;
  if (read > 0) parts.push(`Read ${plural(read, 'file')}`);
  const edited = counts.get('edit') ?? 0;
  if (edited > 0) parts.push(`Edited ${plural(edited, 'file')}`);
  const changed = (counts.get('delete') ?? 0) + (counts.get('move') ?? 0);
  if (changed > 0) parts.push(`Changed ${plural(changed, 'file')}`);
  const executed = counts.get('execute') ?? 0;
  if (executed > 0) parts.push(`Ran ${plural(executed, 'command')}`);
  const searched = counts.get('search') ?? 0;
  if (searched > 0) parts.push(searched > 1 ? `Searched ${searched} times` : 'Searched');
  const fetched = counts.get('fetch') ?? 0;
  if (fetched > 0) parts.push(`Fetched ${plural(fetched, 'page')}`);
  const others = (counts.get('think') ?? 0) + (counts.get('other') ?? 0);
  if (others > 0) parts.push(plural(others, 'step'));
  const started = entries
    .map((entry) => entry.startedAt)
    .filter((value): value is number => value !== undefined);
  const ended = entries
    .map((entry) => entry.endedAt)
    .filter((value): value is number => value !== undefined);
  if (started.length > 0 && ended.length > 0) {
    const seconds = Math.round((Math.max(...ended) - Math.min(...started)) / 1_000);
    if (seconds >= 1) parts.push(`${seconds}s`);
  }
  return parts.join(' · ') || 'Activity';
}

export function activityGroupStatus(
  entries: ComputerActivityEntry[],
): ComputerActivityStatus | null {
  if (entries.some((entry) => entry.status === 'awaiting_input')) return 'awaiting_input';
  if (entries.some((entry) => entry.status === 'running')) return 'running';
  if (entries.some((entry) => entry.status === 'failed')) return 'failed';
  if (entries.some((entry) => entry.status === 'timed_out')) return 'timed_out';
  if (entries.some((entry) => entry.status === 'interrupted')) return 'interrupted';
  if (entries.some((entry) => entry.status === 'unknown')) return 'unknown';
  return null;
}

// ---------------------------------------------------------------------------
// Time labels (from src/lib/messageTime.ts + src/lib/session-utils.ts)
// ---------------------------------------------------------------------------

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatDayLabel(ms: number, now: number): string {
  const date = new Date(ms);
  const current = new Date(now);
  if (localDayKey(ms) === localDayKey(now)) return 'Today';

  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDayKey(ms) === localDayKey(yesterday.getTime())) return 'Yesterday';

  const month = MONTH_ABBREVIATIONS[date.getMonth()];
  return date.getFullYear() === current.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  const hour = date.getHours();
  const displayHour = hour % 12 || 12;
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${displayHour}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatFullDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAY_NAMES[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${formatClockTime(ms)}`;
}

export function messageTimeLabels(
  messages: Array<{ source: string; createdAt?: number }>,
  now: number,
): Array<{ daySeparator?: string; time?: string }> {
  const labels = messages.map(() => ({} as { daySeparator?: string; time?: string }));
  let previousTimestampedDay: string | undefined;

  messages.forEach((message, index) => {
    if (message.createdAt === undefined) return;

    const day = localDayKey(message.createdAt);
    if (day !== previousTimestampedDay) {
      labels[index]!.daySeparator = formatDayLabel(message.createdAt, now);
    }
    previousTimestampedDay = day;

    if (messages[index + 1]?.source !== message.source) {
      labels[index]!.time = formatClockTime(message.createdAt);
    }
  });

  return labels;
}

/** Format a Unix timestamp (seconds) as a relative time string. */
export function formatRelativeTime(
  timestampSeconds: number,
  nowSeconds = Date.now() / 1_000,
): string {
  const diff = nowSeconds - timestampSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`;
  if (diff < 604_800) return `${Math.floor(diff / 86_400)}d ago`;
  return new Date(timestampSeconds * 1_000).toLocaleDateString();
}

/** Row-level relative label for a session's ISO updatedAt string. */
export function sessionTimeLabel(updatedAt: string | undefined, nowSeconds?: number): string | null {
  if (!updatedAt) return null;
  const milliseconds = Date.parse(updatedAt);
  if (!Number.isFinite(milliseconds)) return null;
  return formatRelativeTime(milliseconds / 1_000, nowSeconds);
}
