/**
 * Activity timeline — collapsed-by-default groups under `afterSequence`
 * boundaries, summaries like "Edited N file(s) · Ran N command(s)", and the
 * expanded live turn at the bottom of the transcript. Port of the iPhone
 * ActivityGroup component to the desktop shell.
 */
import { useState } from 'react';
import clsx from 'clsx';

import {
  activityStatusLabel,
  groupStatus,
  summarizeActivity,
} from '../activity-utils';
import type { ActivityEntry, ActivityStatus } from '../types';
import { Icon, type IconName } from './Icon';
import { Markdown } from './Markdown';

const MAX_DIFF_LINES = 200;

const STEP_ICONS: Record<string, IconName> = {
  thought: 'sparkle',
  read: 'doc',
  edit: 'edit',
  delete: 'trash',
  move: 'move',
  search: 'search',
  execute: 'terminal',
  fetch: 'globe',
  think: 'dot',
  other: 'dot',
};

function stepIcon(entry: ActivityEntry): IconName {
  if (entry.kind === 'thought') return 'sparkle';
  return STEP_ICONS[entry.toolKind ?? 'other'] ?? 'dot';
}

function statusTextClass(status: ActivityStatus): string {
  switch (status) {
    case 'failed':
      return 'text-failed';
    case 'awaiting_input':
      return 'text-brandText';
    case 'running':
      return 'text-running';
    default:
      return 'text-blocked';
  }
}

interface DiffLine {
  prefix: ' ' | '+' | '-';
  text: string;
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const lines: DiffLine[] = [];
  for (const text of oldLines.slice(0, head)) lines.push({ prefix: ' ', text });
  for (const text of oldLines.slice(head, oldLines.length - tail)) {
    lines.push({ prefix: '-', text });
  }
  for (const text of newLines.slice(head, newLines.length - tail)) {
    lines.push({ prefix: '+', text });
  }
  for (const text of oldLines.slice(oldLines.length - tail)) lines.push({ prefix: ' ', text });
  return lines;
}

function StepDetail({ entry }: { entry: ActivityEntry }) {
  const [showAll, setShowAll] = useState(false);
  const detail = entry.detail;
  if (!detail) return null;
  if (detail.type === 'diff') {
    const lines = diffLines(detail.oldText ?? '', detail.newText ?? '');
    const visible = showAll ? lines : lines.slice(0, MAX_DIFF_LINES);
    return (
      <div className="mt-1.5 overflow-x-auto rounded-input bg-surface2 px-2 py-2">
        {visible.map((line, index) => (
          <div
            key={`${index}:${line.prefix}`}
            className={clsx(
              'whitespace-pre-wrap font-mono text-[12px] leading-5 selectable',
              line.prefix === '+' && 'bg-diffAddedTint text-diffAddedText',
              line.prefix === '-' && 'bg-diffRemovedTint text-diffRemovedText',
              line.prefix === ' ' && 'text-textMid',
            )}
          >
            {line.prefix} {line.text}
          </div>
        ))}
        {lines.length > MAX_DIFF_LINES && !showAll && (
          <button
            type="button"
            className="mt-1 text-[12px] text-brandText hover:underline"
            onClick={() => setShowAll(true)}
          >
            Show more ({lines.length - MAX_DIFF_LINES} more lines)
          </button>
        )}
        {entry.truncated && <div className="mt-1 text-[11px] text-textLow">Trimmed</div>}
      </div>
    );
  }
  if (entry.kind === 'thought') {
    return (
      <div className="mt-1">
        <p className="text-[12px] italic leading-5 text-textMid selectable">{detail.text}</p>
        {entry.truncated && <div className="mt-1 text-[11px] text-textLow">Trimmed</div>}
      </div>
    );
  }
  return (
    <div
      className={clsx(
        'mt-1.5 rounded-input bg-surface2 px-2 py-2',
        !showAll && 'max-h-48 overflow-hidden',
      )}
    >
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-5 text-textMid selectable">
        {detail.text}
      </pre>
      {!showAll && (
        <button
          type="button"
          className="mt-1 text-[12px] text-brandText hover:underline"
          onClick={() => setShowAll(true)}
        >
          Show more
        </button>
      )}
      {entry.truncated && <div className="mt-1 text-[11px] text-textLow">Trimmed</div>}
    </div>
  );
}

function ActivityStep({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = activityStatusLabel(entry.status);
  const statusIsFinal = entry.status === 'completed';
  const paths = entry.paths ?? [];
  const shownPaths = paths.slice(0, 3);
  const hasDetail = entry.detail !== undefined;

  return (
    <div>
      <button
        type="button"
        className={clsx(
          'flex w-full items-start py-1 text-left',
          hasDetail ? 'cursor-pointer' : 'cursor-default',
        )}
        onClick={() => hasDetail && setExpanded((value) => !value)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span className="mt-0.5 text-textMid">
          <Icon name={stepIcon(entry)} size={13} />
        </span>
        <span className="ml-2 min-w-0 flex-1">
          <span className="flex items-center">
            <span className="flex-1 break-words text-[13px] leading-5 text-textHi">
              {entry.title}
            </span>
            {!statusIsFinal && (
              <span className="ml-2 flex shrink-0 items-center">
                {entry.status === 'running' && (
                  <span className="mr-1 h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-running" />
                )}
                <span className={clsx('ml-1 text-[11px]', statusTextClass(entry.status))}>
                  {statusLabel}
                </span>
              </span>
            )}
          </span>
          {shownPaths.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {shownPaths.map((path) => (
                <span
                  key={path}
                  className="max-w-full truncate rounded-inlineCode bg-tintSecondary px-inlineCodeX py-inlineCodeY font-mono text-[11px] text-textMid"
                >
                  {path}
                </span>
              ))}
              {paths.length > shownPaths.length && (
                <span className="text-[11px] text-textLow">+{paths.length - shownPaths.length}</span>
              )}
            </span>
          )}
        </span>
      </button>
      {hasDetail && expanded && <StepDetail entry={entry} />}
    </div>
  );
}

export function ActivityGroupView({
  groupKey,
  entries,
  live = false,
  defaultExpanded = false,
  reply,
}: {
  groupKey: string;
  entries: ActivityEntry[];
  live?: boolean;
  defaultExpanded?: boolean;
  reply?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const summary = summarizeActivity(entries);
  const status = groupStatus(entries);
  const statusLabel = status ? activityStatusLabel(status) : null;

  const dotClass =
    status === 'awaiting_input'
      ? 'bg-brand'
      : status === 'failed'
        ? 'bg-failed'
        : status === 'timed_out' || status === 'interrupted' || status === 'unknown'
          ? 'bg-blocked'
          : status === 'running'
            ? 'bg-running'
            : null;

  return (
    <div className="mb-4" data-activity-group={groupKey}>
      <button
        type="button"
        className="flex w-full items-center py-1.5 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} className="text-textLow" />
        {status === 'running' ? (
          <span className="ml-1.5 mr-1.5 h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-running" />
        ) : dotClass ? (
          <span className={clsx('ml-1.5 mr-1.5 h-1.5 w-1.5 rounded-dot', dotClass)} />
        ) : (
          <span className="w-3" />
        )}
        <span className="flex-1 truncate text-[12px] text-textMid">{summary}</span>
        {statusLabel && (
          <span className={clsx('ml-2 shrink-0 text-[11px]', statusTextClass(status ?? 'unknown'))}>
            {statusLabel}
          </span>
        )}
      </button>
      {expanded && (
        <div className="ml-1.5 border-l border-borderSubtle pl-3">
          {entries.map((entry) => (
            <ActivityStep key={entry.id} entry={entry} />
          ))}
          {live && (
            <>
              {reply ? (
                <div className="mt-2">
                  <Markdown text={reply} />
                </div>
              ) : null}
              <div className="mt-2 flex items-center">
                <span className="h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-running" />
                <span className="ml-2 text-[12px] text-textLow">Generating…</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
