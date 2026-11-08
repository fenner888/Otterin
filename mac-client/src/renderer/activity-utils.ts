/**
 * Activity-timeline helpers — ports of src/lib/activity-labels.ts and the
 * grouping/summarising logic in src/components/sessions/ActivityGroup.tsx.
 */
import { statusLabels, type StatusLabelKey } from '../../../src/theme/tokens';
import type {
  ActivityEntry,
  ActivityKind,
  ActivityStatus,
  AwaitingKind,
  BoardSession,
  SessionActivity,
} from './types';

const ACTIVITY_SHORT_LABELS: Record<ActivityKind, string> = {
  thinking: 'Thinking',
  reading: 'Reading files',
  editing: 'Editing files',
  executing: 'Running a command',
  searching: 'Searching',
  fetching: 'Fetching',
  responding: 'Responding',
};

export function activityShortLabel(kind: ActivityKind): string {
  return ACTIVITY_SHORT_LABELS[kind] ?? ACTIVITY_SHORT_LABELS.thinking;
}

export function activityStatusLabel(status: ActivityStatus): string {
  const label = statusLabels[status as StatusLabelKey];
  return label ?? statusLabels.unknown;
}

export function awaitingLabel(awaiting: AwaitingKind): string {
  return awaiting === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer';
}

export function groupActivity(entries: ActivityEntry[]): Map<number, ActivityEntry[]> {
  const groups = new Map<number, ActivityEntry[]>();
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

/** "Read 2 files · Edited 1 file · Ran 3 commands · 12s" */
export function summarizeActivity(entries: ActivityEntry[]): string {
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

/** Highest-priority status across a group — drives dot color + label. */
export function groupStatus(entries: ActivityEntry[]): ActivityStatus | null {
  if (entries.some((entry) => entry.status === 'awaiting_input')) return 'awaiting_input';
  if (entries.some((entry) => entry.status === 'running')) return 'running';
  if (entries.some((entry) => entry.status === 'failed')) return 'failed';
  if (entries.some((entry) => entry.status === 'timed_out')) return 'timed_out';
  if (entries.some((entry) => entry.status === 'interrupted')) return 'interrupted';
  if (entries.some((entry) => entry.status === 'unknown')) return 'unknown';
  return null;
}

// ── Session state derivation (PLAN §4 + §7) ─────────────────────────────────

export type SessionDriveState =
  /** Bridge-owned live turn: `active && turn`, or owner==='connector_live'. */
  | 'connector_live'
  /** Locked by another Devin host (locked-idle or externally-driven live). */
  | 'locked_external'
  /** `activity.active` with no turn and no owner — live, attribution unknown. */
  | 'active_unattributed'
  | 'free';

interface RowLike {
  activity?: { active: boolean; awaiting?: AwaitingKind };
  owner?: 'free' | 'locked_external' | 'connector_live';
}

function driveStateFromRow(row: RowLike): SessionDriveState {
  if (row.owner === 'connector_live') return 'connector_live';
  if (row.owner === 'locked_external') return 'locked_external';
  if (row.owner === 'free') return 'free';
  // No owner field (older Connector): derive from the activity signal.
  if (!row.activity) return 'free';
  return row.activity.active ? 'active_unattributed' : 'locked_external';
}

export function sessionDriveState(row: RowLike): SessionDriveState {
  return driveStateFromRow(row);
}

export function sessionDriveStateFromActivity(
  activity: SessionActivity | undefined,
  owner: SessionSummaryOwner | undefined,
): SessionDriveState {
  if (owner === 'connector_live') return 'connector_live';
  if (owner === 'locked_external') return 'locked_external';
  if (owner === 'free') return 'free';
  if (activity?.active && activity.turn) return 'connector_live';
  return driveStateFromRow({ activity });
}

type SessionSummaryOwner = 'free' | 'locked_external' | 'connector_live' | undefined;

export type SidebarGroup = 'live' | 'waiting' | 'locked' | 'recent';

export function sidebarGroup(session: BoardSession): SidebarGroup {
  if (session.activity?.awaiting) return 'waiting';
  const state = driveStateFromRow(session);
  if (state === 'connector_live' || state === 'active_unattributed') return 'live';
  if (state === 'locked_external') return 'locked';
  return 'recent';
}

export const SIDEBAR_GROUP_LABELS: Record<SidebarGroup, string> = {
  live: 'Live in Otterin',
  waiting: 'Waiting for you',
  locked: 'Open in Devin',
  recent: 'Recent',
};
