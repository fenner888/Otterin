/**
 * Permission card — title, command mono block, path chips, decision buttons
 * per the offered `decisions`, and a live countdown to `expiresAt` (10-min
 * auto-cancel). When the countdown hits zero the bridge cancels the request
 * server-side; the next poll returns null and the card retires.
 */
import clsx from 'clsx';

import { useNow } from '../hooks/usePoll';
import { countdownLabel } from '../time';
import type { PermissionDecision, SessionPermission } from '../types';
import { Icon } from './Icon';

const DECISION_ORDER: PermissionDecision[] = ['reject_once', 'allow_session', 'allow_once'];
const DECISION_LABELS: Record<PermissionDecision, string> = {
  reject_once: 'Deny',
  allow_session: 'Allow for this session',
  allow_once: 'Allow',
};

export function PermissionCard({
  permission,
  pending,
  error,
  onRespond,
}: {
  permission: SessionPermission;
  pending: boolean;
  error?: string;
  onRespond(decision: PermissionDecision): void;
}) {
  const now = useNow(1_000);
  const remaining = countdownLabel(permission.expiresAt, now);
  const decisions = DECISION_ORDER.filter((decision) =>
    permission.decisions.includes(decision),
  );

  return (
    <div className="rounded-card border border-brand bg-surface1 px-4 py-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium text-brandText">Devin wants to run a command</div>
        <div
          className="flex items-center text-[11px] text-textLow"
          title="The request cancels itself when this reaches zero"
        >
          <Icon name="clock" size={11} className="mr-1" />
          Expires in {remaining}
        </div>
      </div>
      <div className="mt-1 text-[16px] font-medium text-textHi">{permission.title}</div>
      {permission.command && (
        <div className="mt-3 overflow-x-auto rounded-card bg-surface2 px-3 py-2 font-mono text-[12px] leading-5 text-textHi selectable">
          $ {permission.command}
        </div>
      )}
      {permission.paths && permission.paths.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {permission.paths.map((path) => (
            <span
              key={path}
              className="max-w-full truncate rounded-inlineCode bg-tintSecondary px-inlineCodeX py-inlineCodeY font-mono text-[11px] text-textMid"
            >
              {path}
            </span>
          ))}
        </div>
      )}
      {error && <div className="mt-3 text-[12px] text-failed">{error}</div>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {pending && <span className="mr-auto text-[12px] text-textMid">Sending your decision…</span>}
        {decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={pending}
            onClick={() => onRespond(decision)}
            className={clsx(
              'min-h-9 rounded-chip px-4 text-[13px]',
              decision === 'allow_once'
                ? pending
                  ? 'bg-tintSecondary text-textLow'
                  : 'bg-brand font-medium text-textAlwaysWhite'
                : 'border border-border text-textMid hover:bg-tintSecondary',
            )}
          >
            {DECISION_LABELS[decision]}
          </button>
        ))}
      </div>
    </div>
  );
}
