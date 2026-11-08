/**
 * New-session flow (Cmd+N / "+ New session"): workspace picker with search +
 * "(2)" dedup, model picker (shared ModelPicker), auto-approve toggle, first
 * prompt (10 000-char create limit), then navigate straight to the live
 * session the bridge returns.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { promptErrorMessage } from '../errors';
import { dedupeWorkspaceNames, splitComputerModelName } from '../models';
import { useApp } from '../store';
import { useModelCatalog } from '../useModelCatalog';
import { CREATE_CHAR_LIMIT } from './Composer';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';
import { Popover } from './Popover';

function WorkspacePicker({
  workspaces,
  selectedId,
  onSelect,
}: {
  workspaces: { id: string; name: string }[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const named = useMemo(() => dedupeWorkspaceNames(workspaces), [workspaces]);
  const normalized = query.trim().toLowerCase();
  const results = normalized
    ? named.filter((workspace) => workspace.name.toLowerCase().includes(normalized))
    : named;
  const selected = named.find((workspace) => workspace.id === selectedId);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="flex w-full items-center rounded-input border border-border bg-surface2 px-3 py-2.5 text-left hover:border-borderStrong"
        onClick={() => setOpen(true)}
      >
        <Icon name="folder" size={14} className="mr-2 shrink-0 text-textMid" />
        <span className="flex-1 truncate text-[14px] text-textHi">
          {selected?.displayName ?? 'Choose a workspace'}
        </span>
        <Icon name="chevron-down" size={12} className="ml-2 shrink-0 text-textLow" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={buttonRef.current} width={360} placement="below">
        <div className="flex max-h-[45vh] flex-col">
          <div className="flex items-center border-b border-borderSubtle px-3">
            <Icon name="search" size={13} className="text-textLow" />
            <input
              autoFocus
              className="ml-2 min-h-10 flex-1 bg-transparent text-[13px] text-textHi placeholder:text-textLow focus:outline-none"
              placeholder="Search workspaces"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {results.length === 0 ? (
              <div className="px-4 py-5 text-[13px] text-textLow">No matching workspaces</div>
            ) : (
              results.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="flex w-full items-center px-4 py-2.5 text-left hover:bg-tintSecondary"
                  onClick={() => {
                    onSelect(workspace.id);
                    setOpen(false);
                  }}
                >
                  <Icon name="folder" size={14} className="mr-2.5 shrink-0 text-textMid" />
                  <span className="flex-1 truncate text-[14px] text-textHi">
                    {workspace.displayName}
                  </span>
                  {workspace.id === selectedId && (
                    <Icon name="check" size={15} className="ml-2 shrink-0 text-textHi" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}

export function NewSessionView({ bridgeId }: { bridgeId: string }) {
  const store = useApp();
  const catalog = useModelCatalog(bridgeId);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const computerName =
    store.computers.find((computer) => computer.bridgeId === bridgeId)?.computerName ??
    'this computer';
  const features = store.featuresOf(bridgeId);
  const grants = features?.presentation?.grants;
  const autoApproveSupported = features?.autoApprove === true;
  const mayCreate = grants ? grants.startSessions : true;

  useEffect(() => {
    void catalog.ensure();
    store.ensureFeatures(bridgeId).catch(() => undefined);
  }, [bridgeId, catalog, store]);

  useEffect(() => {
    if (!catalog.options) return;
    if (!modelId && catalog.options.defaultModelId) {
      setModelId(catalog.options.defaultModelId);
    }
  }, [catalog.options, modelId]);

  const options = catalog.options;
  const workspaces = options?.workspaces ?? [];
  const selectedModel = options?.models.find((model) => model.id === modelId);
  const modelLabel = selectedModel
    ? (() => {
        const parts = splitComputerModelName(selectedModel.name);
        return parts.variant === 'Default' ? parts.family : `${parts.family} · ${parts.variant}`;
      })()
    : catalog.loading
      ? 'Loading models…'
      : 'Choose a model';
  const canSubmit =
    workspaceId !== null && text.trim().length > 0 && text.length <= CREATE_CHAR_LIMIT && !creating && mayCreate;

  async function create() {
    if (!workspaceId || !canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await store.bridge.createSession(bridgeId, {
        workspaceId,
        modelId: modelId ?? null,
        text: text.trim(),
        autoApprove: autoApproveSupported ? autoApprove : undefined,
      });
      void store.refreshBoard();
      store.selectSession(bridgeId, result.sessionId, {});
    } catch (error) {
      setCreateError(promptErrorMessage(error, computerName));
      setCreating(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface0">
      <div className="titlebar-drag flex h-11 shrink-0 items-center border-b border-borderSubtle px-4">
        <span className="titlebar-no-drag text-[14px] font-medium text-textHi">
          New session
          <span className="ml-2 text-[12px] font-normal text-textLow">on {computerName}</span>
        </span>
      </div>
      <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-xl">
          {!mayCreate ? (
            <div className="rounded-card border border-border bg-surface1 px-4 py-4">
              <div className="flex items-center text-[13px] font-medium text-textHi">
                <Icon name="lock" size={14} className="mr-2 text-textLow" />
                Starting sessions is off for this Mac
              </div>
              <p className="mt-2 text-[12px] leading-5 text-textMid">
                Enable &quot;Start sessions&quot; for this device in Otterin Connector on{' '}
                {computerName} to create sessions here.
              </p>
            </div>
          ) : (
            <>
              <label className="mb-1.5 block text-[12px] font-medium text-textMid">Workspace</label>
              {options ? (
                <WorkspacePicker
                  workspaces={workspaces}
                  selectedId={workspaceId}
                  onSelect={setWorkspaceId}
                />
              ) : (
                <div className="flex w-full items-center rounded-input border border-border bg-surface2 px-3 py-2.5 text-[14px] text-textLow">
                  {catalog.loading ? 'Loading workspaces…' : 'Workspaces unavailable'}
                </div>
              )}
              {catalog.error && (
                <div className="mt-1.5 text-[11px] text-failed">
                  Could not load workspaces and models from {computerName}.
                </div>
              )}

              <label className="mb-1.5 mt-5 block text-[12px] font-medium text-textMid">Model</label>
              <button
                ref={modelButtonRef}
                type="button"
                className="flex w-full items-center rounded-input border border-border bg-surface2 px-3 py-2.5 text-left hover:border-borderStrong disabled:opacity-60"
                onClick={() => options && setModelPickerOpen(true)}
                disabled={!options}
              >
                <Icon name="sparkle" size={14} className="mr-2 shrink-0 text-textMid" />
                <span className="flex-1 truncate text-[14px] text-textHi">{modelLabel}</span>
                <Icon name="chevron-down" size={12} className="ml-2 shrink-0 text-textLow" />
              </button>
              {options?.catalogSource === 'recent' && (
                <div className="mt-1.5 flex items-center text-[11px] text-textLow">
                  Showing recent models.
                  <button
                    type="button"
                    className="ml-1.5 text-brandText hover:underline disabled:opacity-50"
                    onClick={catalog.refresh}
                    disabled={catalog.refreshing}
                  >
                    {catalog.refreshing ? 'Refreshing…' : 'Load the full catalog'}
                  </button>
                </div>
              )}

              <label className="mb-1.5 mt-5 block text-[12px] font-medium text-textMid">
                First message
              </label>
              <textarea
                className="min-h-28 w-full resize-y rounded-input border border-border bg-surface2 px-3 py-2.5 text-[14px] leading-6 text-textHi placeholder:text-textLow focus:outline-none"
                value={text}
                onChange={(event) => setText(event.target.value.slice(0, CREATE_CHAR_LIMIT))}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
                    event.preventDefault();
                    void create();
                  }
                }}
                placeholder="What should Devin do?"
                rows={4}
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-textLow">
                <span>
                  {text.length > CREATE_CHAR_LIMIT * 0.9 &&
                    `${text.length.toLocaleString()}/${CREATE_CHAR_LIMIT.toLocaleString()}`}
                </span>
                <span>Cmd+Return to start</span>
              </div>

              {autoApproveSupported && (
                <button
                  type="button"
                  className="mt-4 flex items-center text-left"
                  onClick={() => setAutoApprove((value) => !value)}
                  aria-pressed={autoApprove}
                >
                  <Icon
                    name={autoApprove ? 'shield-check' : 'shield'}
                    size={16}
                    className={autoApprove ? 'text-brand' : 'text-textMid'}
                  />
                  <span className="ml-2 text-[13px] text-textMid">
                    Auto-approve this prompt — Devin runs commands without asking first.
                  </span>
                </button>
              )}

              {createError && <div className="mt-3 text-[12px] text-failed">{createError}</div>}
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="min-h-9 rounded-chip border border-border px-4 text-[13px] text-textMid hover:bg-tintSecondary"
                  onClick={store.goHome}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={clsx(
                    'min-h-9 rounded-chip px-5 text-[13px] font-medium',
                    canSubmit ? 'bg-brand text-textAlwaysWhite' : 'bg-tintSecondary text-textLow',
                  )}
                  disabled={!canSubmit}
                  onClick={() => void create()}
                >
                  {creating ? 'Starting…' : 'Start session'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <ModelPicker
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        anchor={modelButtonRef.current}
        models={options?.models ?? []}
        selectedModelId={modelId}
        onSelect={(id) => {
          setModelId(id);
          setModelPickerOpen(false);
        }}
        catalogSource={options?.catalogSource}
        onRefresh={catalog.refresh}
        refreshing={catalog.refreshing}
        refreshError={catalog.refreshError}
      />
    </div>
  );
}
