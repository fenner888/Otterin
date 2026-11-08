/**
 * Transcript pane: day separators + relative timestamps, user bubbles right,
 * Devin replies as sanitized markdown, activity groups under afterSequence
 * boundaries, the expanded live turn at the bottom, truncated + continued +
 * external-live banners, auto-scroll pinned with a jump-to-bottom pill.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

import { groupActivity } from '../activity-utils';
import { formatFullDate, messageTimeLabels } from '../time';
import type { LoadedSession, SessionMessage, TurnSnapshot } from '../types';
import { ActivityGroupView } from './ActivityGroupView';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

export interface TranscriptHandle {
  scrollToBottom(): void;
}

function HistoryMessage({
  message,
  daySeparator,
  time,
}: {
  message: SessionMessage;
  daySeparator?: string;
  time?: string;
}) {
  const [showFullDate, setShowFullDate] = useState(false);
  const isUser = message.source === 'user';
  const author = isUser ? 'You' : 'Devin';
  const authorLine = time ? `${author} · ${time}` : author;

  const authorLabel = (
    <div className={clsx('mt-1 text-[11px] text-textLow', !isUser && 'mt-1.5')}>
      <button
        type="button"
        className={clsx(message.createdAt !== undefined && 'cursor-pointer hover:text-textMid')}
        onClick={() => message.createdAt !== undefined && setShowFullDate((v) => !v)}
        title={message.createdAt !== undefined ? 'Show the full date' : undefined}
      >
        {authorLine}
      </button>
      {showFullDate && message.createdAt !== undefined && (
        <div className="mt-0.5">{formatFullDate(message.createdAt)}</div>
      )}
    </div>
  );

  return (
    <>
      {daySeparator && (
        <div className="mb-4 mt-2 w-full text-center text-[11px] text-textLow">{daySeparator}</div>
      )}
      <div
        className={clsx(
          isUser ? 'mb-4 ml-auto flex max-w-[80%] flex-col items-end' : 'mb-5 max-w-full',
        )}
      >
        {isUser ? (
          <>
            <div className="whitespace-pre-wrap break-words rounded-2xl bg-tintPrimary px-4 py-3 text-[14px] leading-6 text-textHi selectable">
              {message.text}
            </div>
            {authorLabel}
          </>
        ) : (
          <>
            <Markdown text={message.text} />
            {authorLabel}
          </>
        )}
      </div>
    </>
  );
}

const TranscriptInner = forwardRef<
  TranscriptHandle,
  {
    loaded: LoadedSession;
    activitySupported: boolean;
    liveTurn: TurnSnapshot | null;
    externalLive: boolean;
    pendingText: string | null;
    continued: boolean;
    steering: boolean;
  }
>(function TranscriptInner(
  { loaded, activitySupported, liveTurn, externalLive, pendingText, continued, steering },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJumpPill, setShowJumpPill] = useState(false);
  const now = Date.now();

  const activityGroups = useMemo(
    () => (activitySupported ? groupActivity(loaded.activity ?? []) : new Map<number, never>()),
    [activitySupported, loaded.activity],
  );
  const timeLabels = useMemo(
    () => messageTimeLabels(loaded.messages, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded.messages],
  );

  const scrollToBottom = (smooth = true) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      nearBottomRef.current = true;
      setShowJumpPill(false);
      scrollToBottom(true);
    },
  }));

  // Auto-scroll pinned: stay at the tail while content grows, but never
  // yank the user down when they scrolled up to read.
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom(false);
  }, [
    loaded.messages.length,
    liveTurn?.reply,
    liveTurn?.activity.length,
    pendingText,
    steering,
  ]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distance <= 80;
    nearBottomRef.current = nearBottom;
    setShowJumpPill(!nearBottom);
  };

  const zeroGroup = activityGroups.get(0) ?? [];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-40 pt-5"
      >
        {loaded.truncated && (
          <div className="mb-5 flex items-start rounded-card border border-borderSubtle bg-surface1 px-3 py-3">
            <Icon name="info" size={15} className="mt-0.5 shrink-0 text-textMid" />
            <p className="ml-2 flex-1 text-[12px] leading-4 text-textMid">
              Older content was omitted to keep this private-device transfer small.
            </p>
          </div>
        )}
        {continued && (
          <div className="mb-5 flex items-start rounded-card border border-borderSubtle bg-surface1 px-3 py-3">
            <Icon name="branch" size={15} className="mt-0.5 shrink-0 text-brandText" />
            <p className="ml-2 flex-1 text-[12px] leading-4 text-textMid">
              {steering ? 'Continuing' : 'Continued'} in a new session while the original
              remains open in the other Devin client.
            </p>
          </div>
        )}
        {activitySupported && zeroGroup.length > 0 && (
          <ActivityGroupView groupKey="g0" entries={zeroGroup} />
        )}
        {loaded.messages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[14px] text-textMid">No replayable text was returned.</span>
          </div>
        ) : (
          loaded.messages.map((message, index) => {
            const group = activitySupported ? (activityGroups.get(message.sequence) ?? []) : [];
            const suppressTrailing =
              liveTurn !== null && message.sequence === loaded.messages.length;
            return (
              <div key={message.sequence}>
                <HistoryMessage
                  message={message}
                  daySeparator={timeLabels[index]?.daySeparator}
                  time={timeLabels[index]?.time}
                />
                {group.length > 0 && !suppressTrailing && (
                  <ActivityGroupView groupKey={`g${message.sequence}`} entries={group} />
                )}
              </div>
            );
          })
        )}
        {pendingText && (
          <div className="mb-4 ml-auto flex max-w-[80%] flex-col items-end opacity-70">
            <div className="whitespace-pre-wrap break-words rounded-2xl bg-tintPrimary px-4 py-3 text-[14px] leading-6 text-textHi selectable">
              {pendingText}
            </div>
            <div className="mt-1 text-[11px] text-textLow">Sending…</div>
          </div>
        )}
        {liveTurn && (
          <ActivityGroupView
            groupKey={`live-${liveTurn.startedAt}`}
            entries={liveTurn.activity}
            live
            defaultExpanded
            reply={liveTurn.reply || undefined}
          />
        )}
        {externalLive && (
          <div className="mb-4 flex items-start rounded-card border border-borderSubtle bg-surface1 px-3 py-3">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-otterin-pulse rounded-dot bg-running" />
            <p className="ml-2 flex-1 text-[12px] leading-4 text-textMid">
              Devin is working in another client. New messages appear here as they are saved.
            </p>
          </div>
        )}
      </div>
      {showJumpPill && (
        <button
          type="button"
          onClick={() => {
            nearBottomRef.current = true;
            setShowJumpPill(false);
            scrollToBottom(true);
          }}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center rounded-chip border border-border bg-surface2 px-3 py-1.5 text-[12px] text-textHi shadow-lg hover:bg-tintSecondary"
        >
          <Icon name="jump-down" size={13} className="mr-1.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
});

export const Transcript = TranscriptInner;
