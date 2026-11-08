/**
 * Sidebar — 300px, vibrancy-ish surface. Search (Cmd+F), "+ New session",
 * session rows grouped "Live in Otterin" → "Waiting for you" → "Open in
 * Devin" → "Recent", discovery notices, and a footer with connector health +
 * computer name + grants popover + settings.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import {
  activityShortLabel,
  awaitingLabel,
  SIDEBAR_GROUP_LABELS,
  sidebarGroup,
  type SidebarGroup,
} from '../activity-utils';
import { discoveryMessage } from '../errors';
import { relativeTimeMs } from '../time';
import { useApp, type Selection } from '../store';
import type { BoardSession, ComputerGrants } from '../types';
import { Icon } from './Icon';
import { Popover } from './Popover';

const GROUP_ORDER: SidebarGroup[] = ['live', 'waiting', 'locked', 'recent'];

function statusDotClass(session: BoardSession): string {
  if (session.activity?.awaiting) return 'bg-blocked animate-otterin-pulse';
  const group = sidebarGroup(session);
  if (group === 'live') return 'bg-running animate-otterin-pulse';
  if (group === 'locked') return 'bg-blocked';
  return 'bg-textLow';
}

function rowSecondLine(session: BoardSession): string {
  const parts: string[] = [session.workspaceName];
  if (session.model?.name) parts.push(session.model.name);
  if (session.activity?.awaiting) {
    parts.push(awaitingLabel(session.activity.awaiting));
  } else if (session.activity?.active) {
    parts.push(activityShortLabel(session.activity.kind ?? 'thinking'));
  }
  if (session.updatedAt) {
    const ms = Date.parse(session.updatedAt);
    if (Number.isFinite(ms)) parts.push(relativeTimeMs(ms));
  }
  return parts.join(' · ');
}

function SessionRow({
  session,
  selected,
  showComputer,
  index,
  onPress,
}: {
  session: BoardSession;
  selected: boolean;
  showComputer: boolean;
  index: number;
  onPress(): void;
}) {
  const primary =
    session.title ?? (session.hasTitle ? 'Session title hidden' : session.workspaceName);
  return (
    <button
      type="button"
      onClick={onPress}
      className={clsx(
        'flex w-full items-start rounded-card px-navItemX py-navItemY text-left',
        selected ? 'bg-tintPrimary' : 'hover:bg-tintTertiary',
      )}
    >
      <span className={clsx('mt-[7px] h-2 w-2 shrink-0 rounded-dot', statusDotClass(session))} />
      <span className="ml-2.5 min-w-0 flex-1">
        <span
          className={clsx(
            'block truncate text-[13px] leading-5',
            selected ? 'text-textHiStrong' : 'text-textHi',
          )}
        >
          {primary}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-textLow">
          {showComputer && <span className="text-brandText">{session.computerName} · </span>}
          {rowSecondLine(session)}
        </span>
      </span>
      {index < 9 && (
        <kbd className="ml-2 mt-1 shrink-0 rounded border border-borderSubtle px-1 text-[10px] text-textLow">
          ⌘{index + 1}
        </kbd>
      )}
    </button>
  );
}

function GrantsPopover({
  anchor,
  onClose,
}: {
  anchor: HTMLElement | null;
  onClose(): void;
}) {
  const store = useApp();
  const computer =
    store.computers.find((candidate) =>
      store.statuses.some(
        (status) => status.bridgeId === candidate.bridgeId && status.state === 'ready',
      ),
    ) ?? store.computers[0];
  const [grants, setGrants] = useState<ComputerGrants | undefined>(
    computer ? store.featuresOf(computer.bridgeId)?.presentation?.grants : undefined,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!computer) return;
    store
      .ensureFeatures(computer.bridgeId)
      .then((features) => setGrants(features.presentation?.grants))
      .catch(() => setFailed(true));
  }, [computer, store]);

  const rows: [string, boolean | undefined][] = [
    ['View sessions', grants?.viewSessions],
    ['Send prompts', grants?.sendPrompts],
    ['Start sessions', grants?.startSessions],
  ];

  return (
    <Popover open onClose={onClose} anchor={anchor} width={280} placement="above">
      <div className="px-4 py-3">
        <div className="text-[13px] font-medium text-textHi">
          {computer ? `Grants on ${computer.computerName}` : 'Device grants'}
        </div>
        <div className="mt-2.5 space-y-2">
          {rows.map(([label, enabled]) => (
            <div key={label} className="flex items-center justify-between text-[12px]">
              <span className="text-textMid">{label}</span>
              {enabled === undefined ? (
                <span className="text-[11px] text-textLow">{failed ? 'unknown' : '…'}</span>
              ) : (
                <span
                  className={clsx(
                    'rounded-chip px-2 py-0.5 text-[11px] font-medium',
                    enabled ? 'bg-tintGreen text-finished' : 'bg-tintSecondary text-textLow',
                  )}
                >
                  {enabled ? 'On' : 'Off'}
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-textLow">
          Turn grants on or off for this Mac in Otterin Connector.
        </p>
      </div>
    </Popover>
  );
}

export function Sidebar({
  ordered,
  selection,
}: {
  ordered: BoardSession[];
  selection: Selection;
}) {
  const store = useApp();
  const searchRef = useRef<HTMLInputElement>(null);
  const footerButtonRef = useRef<HTMLButtonElement>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const showComputerNames = store.computers.length > 1;

  useEffect(() => {
    store.searchFocusRef.current = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    return () => {
      store.searchFocusRef.current = null;
    };
  }, [store]);

  const groups = useMemo(() => {
    const grouped = new Map<SidebarGroup, BoardSession[]>();
    for (const session of ordered) {
      const group = sidebarGroup(session);
      const bucket = grouped.get(group);
      if (bucket) bucket.push(session);
      else grouped.set(group, [session]);
    }
    return grouped;
  }, [ordered]);

  const notices = store.statuses
    .map((status) => ({ key: status.bridgeId, message: discoveryMessage(status) }))
    .filter((notice): notice is { key: string; message: string } => notice.message !== null);

  const primaryComputer = store.computers[0];
  const primaryHealth = primaryComputer
    ? store.healthOf(primaryComputer.bridgeId)
    : undefined;
  const primaryStatus = primaryComputer
    ? store.statuses.find((status) => status.bridgeId === primaryComputer.bridgeId)
    : undefined;
  const footerDot =
    !primaryComputer || !store.boardReady
      ? 'bg-textLow'
      : primaryStatus?.state === 'ready'
        ? 'bg-finished'
        : 'bg-blocked';

  return (
    <aside className="flex w-sidebarWidth shrink-0 flex-col border-r border-borderSubtle bg-surface1">
      {/* titlebar drag strip clears the traffic lights. */}
      <div className="titlebar-drag px-3 pb-2 pt-9">
        <div className="titlebar-no-drag flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-input border border-borderSubtle bg-surface2 px-2.5">
            <Icon name="search" size={13} className="shrink-0 text-textLow" />
            <input
              ref={searchRef}
              value={store.searchQuery}
              onChange={(event) => store.setSearchQuery(event.target.value)}
              placeholder="Search sessions"
              className="ml-2 min-h-8 min-w-0 flex-1 bg-transparent text-[13px] text-textHi placeholder:text-textLow focus:outline-none"
              aria-label="Search sessions"
            />
          </div>
          <button
            type="button"
            className="flex min-h-8 shrink-0 items-center rounded-input bg-brand px-2.5 text-[12px] font-medium text-textAlwaysWhite hover:bg-brandHover"
            onClick={() => store.startCreate()}
            title="New session (Cmd+N)"
          >
            <Icon name="plus" size={13} className="mr-1" />
            New session
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {notices.map((notice) => (
          <div
            key={notice.key}
            className="mx-1 mb-2 flex items-start rounded-card border border-borderSubtle bg-surface2 px-3 py-2.5"
          >
            <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-blocked" />
            <span className="ml-2 flex-1 text-[11px] leading-4 text-textMid">{notice.message}</span>
          </div>
        ))}

        {!store.boardReady ? (
          <div className="flex items-center justify-center py-10">
            <span className="h-2 w-2 animate-otterin-pulse rounded-dot bg-brand" />
            <span className="ml-2 text-[12px] text-textMid">Checking computers…</span>
          </div>
        ) : ordered.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <div className="text-[13px] text-textMid">
              {store.searchQuery ? 'No matching sessions' : 'No sessions yet'}
            </div>
            {!store.searchQuery && (
              <div className="mt-1 text-[11px] leading-4 text-textLow">
                Sessions on your paired computers appear here.
              </div>
            )}
          </div>
        ) : (
          GROUP_ORDER.map((group) => {
            const rows = groups.get(group);
            if (!rows || rows.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <div className="px-navItemX pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-textLow">
                  {SIDEBAR_GROUP_LABELS[group]}
                </div>
                {rows.map((session) => {
                  const flatIndex = ordered.indexOf(session);
                  return (
                    <SessionRow
                      key={`${session.bridgeId}:${session.id}`}
                      session={session}
                      selected={
                        selection.kind === 'session' &&
                        selection.bridgeId === session.bridgeId &&
                        selection.sessionId === session.id
                      }
                      showComputer={showComputerNames}
                      index={flatIndex}
                      onPress={() => store.selectSession(session.bridgeId, session.id)}
                    />
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-borderSubtle px-3 py-2.5">
        <div className="flex items-center">
          <button
            ref={footerButtonRef}
            type="button"
            className="flex min-w-0 flex-1 items-center rounded-card px-1.5 py-1 text-left hover:bg-tintTertiary"
            onClick={() => setGrantsOpen((open) => !open)}
            title="Connector health and device grants"
          >
            <span className={clsx('h-2 w-2 shrink-0 rounded-dot', footerDot)} />
            <span className="ml-2 min-w-0 flex-1 truncate text-[12px] text-textMid">
              {primaryComputer
                ? primaryHealth
                  ? `${primaryComputer.computerName} · connected`
                  : `${primaryComputer.computerName} · ${primaryStatus?.state === 'busy' ? 'busy' : 'offline'}`
                : 'No paired computers'}
            </span>
            <Icon name="chevron-down" size={11} className="ml-1 shrink-0 -rotate-180 text-textLow" />
          </button>
          <button
            type="button"
            className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-textMid hover:bg-tintSecondary"
            onClick={store.openSettings}
            title="Settings"
          >
            <Icon name="gear" size={16} />
          </button>
        </div>
        {store.lastBoardAt && (
          <div className="px-1.5 pt-1 text-[10px] text-textLow">
            List updated {relativeTimeMs(store.lastBoardAt)}
          </div>
        )}
      </div>
      {grantsOpen && (
        <GrantsPopover anchor={footerButtonRef.current} onClose={() => setGrantsOpen(false)} />
      )}
    </aside>
  );
}
