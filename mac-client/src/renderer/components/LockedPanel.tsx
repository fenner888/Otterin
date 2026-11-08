/**
 * Locked-session panel — replaces the composer when another Devin client on
 * this Mac owns the session. Monitor + fork-continue only: the draft sends
 * through session.prompt on the locked session, the bridge returns a new
 * sessionId, and the view navigates with the "Continued" info bar.
 * "Open Devin" is an app-level stub on the documented `app:openDevin`
 * channel — no per-session deep link exists (PLAN §7).
 */
import { useState } from 'react';

import { PROMPT_CHAR_LIMIT } from './Composer';
import { Icon } from './Icon';

export function LockedPanel({
  draft,
  setDraft,
  send,
  sending,
  ownerName,
  promptError,
  onOpenDevin,
}: {
  draft: string;
  setDraft(text: string): void;
  send(): void;
  sending: boolean;
  ownerName: string | undefined;
  promptError: string | null;
  onOpenDevin(): void;
}) {
  const [openDevinNote, setOpenDevinNote] = useState<string | null>(null);
  const sendReady = draft.trim().length > 0 && !sending;

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="rounded-card border border-border bg-surface1 px-4 py-4">
        <div className="flex items-center text-[12px] font-medium text-blocked">
          <Icon name="lock" size={13} className="mr-1.5" />
          Open in another Devin client on this Mac{ownerName ? ` (${ownerName})` : ''}
        </div>
        <p className="mt-2 text-[13px] leading-5 text-textMid">
          Devin allows one driver at a time. Read the live history here, close it in the other
          app to take over, or continue the work in a new session.
        </p>
        {promptError && <div className="mt-2 text-[12px] text-failed">{promptError}</div>}
        {openDevinNote && <div className="mt-2 text-[12px] text-textLow">{openDevinNote}</div>}
        <textarea
          className="mt-3 max-h-28 min-h-[44px] w-full resize-none rounded-input border border-border bg-surface2 px-3 py-2 text-[14px] leading-6 text-textHi placeholder:text-textLow focus:outline-none disabled:opacity-60"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, PROMPT_CHAR_LIMIT))}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && sendReady) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Describe what Devin should do next in a new session…"
          disabled={sending}
          rows={3}
          aria-label="Continue in a new session"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className="min-h-9 rounded-chip border border-border px-4 text-[13px] text-textMid hover:bg-tintSecondary"
            onClick={() => {
              setOpenDevinNote(null);
              Promise.resolve(onOpenDevin()).catch(() =>
                setOpenDevinNote('Could not open the Devin app from here.'),
              );
            }}
            title="Opens the Devin app (app-level; there is no per-session link)"
          >
            <span className="flex items-center">
              <Icon name="external" size={13} className="mr-1.5" />
              Open Devin
            </span>
          </button>
          <button
            type="button"
            className={
              sendReady
                ? 'min-h-9 rounded-chip bg-brand px-4 text-[13px] font-medium text-textAlwaysWhite'
                : 'min-h-9 rounded-chip bg-tintSecondary px-4 text-[13px] text-textLow'
            }
            onClick={send}
            disabled={!sendReady}
            title="Sends your draft to a new session that continues this one"
          >
            {sending ? 'Continuing…' : 'Continue in a new session'}
          </button>
        </div>
      </div>
    </div>
  );
}
