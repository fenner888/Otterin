/**
 * Settings — paired computers with per-computer health, unpair via
 * device:revoke (revoked rows stay listed with a "Pair again" action),
 * polling mode picker, and About (app + connector versions, protocol).
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';

import { publicErrorMessage } from '../errors';
import { formatFullDate } from '../time';
import { useApp } from '../store';
import type { PollingMode } from '../types';
import { Icon } from './Icon';

const POLLING_OPTIONS: { id: PollingMode; label: string; hint: string }[] = [
  {
    id: 'battery_saver',
    label: 'Battery saver',
    hint: 'Slowest polling. Session list every minute; an open session refreshes every few seconds.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Default. Session list every 30 seconds; a live turn refreshes about every 1.5 seconds.',
  },
  {
    id: 'fast',
    label: 'Fast',
    hint: 'Most responsive. Session list every 15 seconds; live turns refresh every second.',
  },
];

function ComputerRow({
  bridgeId,
  computerName,
  pairedAt,
  transportKind,
  onRevoked,
}: {
  bridgeId: string;
  computerName: string;
  pairedAt: number;
  transportKind: string;
  onRevoked(name: string): void;
}) {
  const store = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const health = store.healthOf(bridgeId);
  const status = store.statuses.find((candidate) => candidate.bridgeId === bridgeId);
  const online = health !== undefined && status?.state !== 'unavailable';

  useEffect(() => {
    let cancelled = false;
    store.bridge
      .version(bridgeId)
      .then((result) => {
        if (!cancelled) setVersion(result.version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridgeId, store]);

  return (
    <div className="rounded-card border border-borderSubtle bg-surface2 px-4 py-3">
      <div className="flex items-center">
        <span
          className={clsx(
            'h-2 w-2 shrink-0 rounded-dot',
            online ? 'bg-finished' : 'bg-blocked',
          )}
        />
        <div className="ml-2.5 min-w-0 flex-1">
          <div className="truncate text-[14px] text-textHi">{computerName}</div>
          <div className="mt-0.5 truncate text-[11px] text-textLow">
            {online ? 'Connected' : 'Offline'}
            {version ? ` · Connector ${version}` : ''}
            {` · ${transportKind === 'tailscale_vpn' ? 'Tailscale' : 'Local network'}`}
            {` · paired ${formatFullDate(pairedAt)}`}
          </div>
        </div>
        <button
          type="button"
          className="ml-3 shrink-0 rounded-chip border border-border px-3 py-1.5 text-[12px] text-destructive hover:bg-tintSecondary disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await store.bridge.revokeDevice(bridgeId);
              onRevoked(computerName);
              void store.refreshBoard();
            } catch (revokeError) {
              setError(publicErrorMessage(revokeError));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Unpairing…' : 'Unpair'}
        </button>
      </div>
      {error && <div className="mt-2 text-[11px] text-failed">{error}</div>}
    </div>
  );
}

export function SettingsView({ onRePair }: { onRePair(): void }) {
  const store = useApp();
  const [revokedNames, setRevokedNames] = useState<string[]>([]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface0">
      <div className="titlebar-drag flex h-11 shrink-0 items-center border-b border-borderSubtle px-4">
        <span className="titlebar-no-drag text-[14px] font-medium text-textHi">Settings</span>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-xl">
          <div className="text-[12px] font-medium uppercase tracking-wide text-textLow">
            Paired computers
          </div>
          <div className="mt-2 space-y-2">
            {store.computers.map((computer) => (
              <ComputerRow
                key={computer.bridgeId}
                bridgeId={computer.bridgeId}
                computerName={computer.computerName}
                pairedAt={computer.pairedAt}
                transportKind={computer.transportKind}
                onRevoked={(name) => setRevokedNames((names) => [...names, name])}
              />
            ))}
            {revokedNames.map((name) => (
              <div
                key={`revoked-${name}`}
                className="flex items-center rounded-card border border-dashed border-border px-4 py-3"
              >
                <Icon name="desktop" size={15} className="shrink-0 text-textLow" />
                <div className="ml-2.5 min-w-0 flex-1">
                  <div className="truncate text-[13px] text-textMid">{name}</div>
                  <div className="text-[11px] text-textLow">
                    Unpaired. Pair again from the Connector pairing window.
                  </div>
                </div>
                <button
                  type="button"
                  className="ml-3 shrink-0 rounded-chip bg-brand px-3 py-1.5 text-[12px] font-medium text-textAlwaysWhite"
                  onClick={onRePair}
                >
                  Pair again
                </button>
              </div>
            ))}
            {store.computers.length === 0 && revokedNames.length === 0 && (
              <div className="rounded-card border border-dashed border-border px-4 py-6 text-center">
                <div className="text-[13px] text-textMid">No paired computers</div>
                <button
                  type="button"
                  className="mt-3 rounded-chip bg-brand px-4 py-1.5 text-[12px] font-medium text-textAlwaysWhite"
                  onClick={onRePair}
                >
                  Pair a computer
                </button>
              </div>
            )}
          </div>

          <div className="mt-8 text-[12px] font-medium uppercase tracking-wide text-textLow">
            Polling
          </div>
          <div className="mt-2 space-y-2">
            {POLLING_OPTIONS.map((option) => {
              const selected = store.pollingMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={clsx(
                    'flex w-full items-center rounded-card border px-4 py-3 text-left',
                    selected
                      ? 'border-brand bg-tintPrimary'
                      : 'border-borderSubtle bg-surface2 hover:bg-tintTertiary',
                  )}
                  onClick={() => store.setPollingMode(option.id)}
                >
                  <span
                    className={clsx(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      selected ? 'border-brand' : 'border-borderStrong',
                    )}
                  >
                    {selected && <span className="h-2 w-2 rounded-dot bg-brand" />}
                  </span>
                  <span className="ml-3 min-w-0 flex-1">
                    <span className="block text-[13px] text-textHi">{option.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-textLow">
                      {option.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 text-[12px] font-medium uppercase tracking-wide text-textLow">
            About
          </div>
          <div className="mt-2 rounded-card border border-borderSubtle bg-surface2 px-4 py-3 text-[12px] leading-5 text-textMid">
            <div className="flex justify-between">
              <span>Otterin for Mac</span>
              <span className="text-textLow">Connector protocol 2</span>
            </div>
            <div className="mt-1 text-[11px] leading-4 text-textLow">
              Monitor and steer Devin sessions on computers running Otterin Connector. Polling only
              — sessions stay local to the computer that owns them.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
