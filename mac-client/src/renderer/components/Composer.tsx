/**
 * Composer — multiline, Cmd+Return sends (Enter = newline), model picker
 * button, write-only auto-approve shield, optimistic-send handled by the
 * controller (pendingText bubble in the transcript). Disabled states map
 * §5/§7 copy: connector-busy, terminal question, missing prompt grant is
 * handled by the read-only bar above this component.
 */
import { useRef, useState } from 'react';
import clsx from 'clsx';

import { splitComputerModelName, type ComputerModel } from '../models';
import type { ComputerGrants } from '../types';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';

export const PROMPT_CHAR_LIMIT = 100_000;
export const CREATE_CHAR_LIMIT = 10_000;

export interface ModelCatalogState {
  models: ComputerModel[];
  loading: boolean;
  error: boolean;
  catalogSource?: 'live' | 'recent';
  refreshing: boolean;
  refreshError: boolean;
  open(): void;
  refresh(): void;
}

export function Composer({
  draft,
  setDraft,
  send,
  sending,
  busy,
  canCancel,
  stop,
  terminalHint,
  promptError,
  cancelError,
  catalog,
  selectedModelId,
  onSelectModel,
  sessionModelName,
  autoApproveSupported,
  autoApprove,
  toggleAutoApprove,
  workspaceName,
}: {
  draft: string;
  setDraft(text: string): void;
  send(): void;
  sending: boolean;
  busy: boolean;
  canCancel: boolean;
  stop(): void;
  terminalHint: string | null;
  promptError: string | null;
  cancelError: string | null;
  catalog: ModelCatalogState;
  selectedModelId: string | null;
  onSelectModel(modelId: string): void;
  sessionModelName?: string;
  autoApproveSupported: boolean;
  autoApprove: boolean;
  toggleAutoApprove(): void;
  workspaceName: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const inputDisabled = sending || busy || terminalHint !== null;
  const sendReady = draft.trim().length > 0 && !inputDisabled;
  const selectedModel = selectedModelId
    ? catalog.models.find((model) => model.id === selectedModelId)
    : undefined;
  const modelLabel = selectedModel
    ? splitComputerModelName(selectedModel.name).family
    : (sessionModelName ? splitComputerModelName(sessionModelName).family : 'Default model');
  const variantLabel = selectedModel
    ? splitComputerModelName(selectedModel.name).variant
    : null;
  const overLimit = draft.length > PROMPT_CHAR_LIMIT;
  const nearLimit = draft.length > PROMPT_CHAR_LIMIT * 0.95;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (sendReady) send();
    }
  };

  return (
    <div className="px-4 pb-4 pt-1">
      {cancelError && <div className="mb-2 text-[12px] text-failed">{cancelError}</div>}
      {promptError && <div className="mb-2 text-[12px] text-failed">{promptError}</div>}
      {autoApproveSupported && autoApprove && (
        <div className="mb-2 text-[12px] text-textMid">
          Auto-approve is on for your next message from this Mac.
        </div>
      )}
      {busy && (
        <div className="mb-2 text-[12px] text-textMid">
          The connector is busy with another turn.
        </div>
      )}
      <div className="rounded-card border border-border bg-composerSurface px-3 pb-2 pt-2">
        <textarea
          ref={textareaRef}
          className="max-h-32 min-h-[44px] w-full resize-none bg-transparent px-1 text-[14px] leading-6 text-textHi placeholder:text-textLow focus:outline-none disabled:opacity-60"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, PROMPT_CHAR_LIMIT))}
          onKeyDown={onKeyDown}
          placeholder={
            terminalHint ??
            (busy ? 'The connector is busy with another turn' : 'Send a message to this Devin session…')
          }
          disabled={inputDisabled}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          aria-label="Session message"
        />
        <div className="mt-1 flex items-center">
          <button
            ref={modelButtonRef}
            type="button"
            className="flex min-w-0 items-center rounded-chip px-2 py-1.5 hover:bg-tintSecondary disabled:opacity-60"
            onClick={() => {
              catalog.open();
              setModelPickerOpen(true);
            }}
            disabled={inputDisabled}
            title="Choose a model for your next message"
          >
            <Icon name="sparkle" size={13} className="mr-1.5 shrink-0 text-textMid" />
            <span className="max-w-40 truncate text-[13px] text-textMid">
              {modelLabel}
              {variantLabel ? ` · ${variantLabel}` : ''}
            </span>
            <Icon name="chevron-down" size={11} className="ml-1 shrink-0 text-textLow" />
          </button>
          {nearLimit && (
            <span className={clsx('ml-2 text-[11px]', overLimit ? 'text-failed' : 'text-textLow')}>
              {draft.length.toLocaleString()}/{PROMPT_CHAR_LIMIT.toLocaleString()}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {autoApproveSupported && (
              <button
                type="button"
                className={clsx(
                  'flex h-9 w-9 items-center justify-center rounded-full',
                  autoApprove ? 'text-brand' : 'text-textMid hover:bg-tintSecondary',
                )}
                onClick={toggleAutoApprove}
                title={
                  autoApprove
                    ? 'Auto-approve this prompt: on'
                    : 'Auto-approve this prompt: Devin will run commands without asking first'
                }
                aria-pressed={autoApprove}
              >
                <Icon name={autoApprove ? 'shield-check' : 'shield'} size={18} />
              </button>
            )}
            {busy && canCancel ? (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive text-textAlwaysWhite"
                onClick={stop}
                title="Stop this turn"
              >
                <Icon name="stop" size={15} />
              </button>
            ) : (
              <button
                type="button"
                className={clsx(
                  'flex h-9 w-9 items-center justify-center rounded-full',
                  sendReady ? 'bg-brand text-textAlwaysWhite' : 'bg-tintSecondary text-textLow',
                )}
                onClick={send}
                disabled={!sendReady}
                title="Send (Cmd+Return)"
              >
                <Icon name="arrow-up" size={17} />
              </button>
            )}
          </span>
        </div>
      </div>
      <div className="flex items-center px-1 pt-2 text-[11px] text-textLow">
        <Icon name="folder" size={12} className="mr-1.5 shrink-0" />
        <span className="truncate">{workspaceName}</span>
        <span className="ml-auto shrink-0 pl-3">Cmd+Return to send</span>
      </div>
      <ModelPicker
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        anchor={modelButtonRef.current}
        models={catalog.models}
        selectedModelId={selectedModelId}
        onSelect={(modelId) => {
          onSelectModel(modelId);
          setModelPickerOpen(false);
        }}
        catalogSource={catalog.catalogSource}
        onRefresh={catalog.refresh}
        refreshing={catalog.refreshing}
        refreshError={catalog.refreshError}
      />
    </div>
  );
}

/**
 * Read-only composer bar — no `session:prompt:send` grant. Clicking it opens
 * the permissions explainer.
 */
export function ReadOnlyComposerBar({
  grants,
  computerName,
  onViewPermissions,
}: {
  grants: ComputerGrants | undefined;
  computerName: string;
  onViewPermissions(): void;
}) {
  return (
    <div className="px-4 pb-4 pt-1">
      <button
        type="button"
        className="flex w-full items-center rounded-card border border-border bg-composerSurface px-4 py-3 text-left"
        onClick={onViewPermissions}
      >
        <Icon name="lock" size={14} className="mr-2.5 shrink-0 text-textLow" />
        <span className="flex-1 text-[13px] text-textMid">
          Read only — enable &quot;Send prompts&quot; for this Mac in Otterin Connector on{' '}
          {computerName} to steer this session.
        </span>
        <span className="ml-2 flex shrink-0 items-center text-[12px] text-brandText">
          View permissions
          <Icon name="chevron-right" size={12} className="ml-1" />
        </span>
      </button>
      {grants && (
        <div className="px-1 pt-2 text-[11px] text-textLow">
          Grants: view sessions {grants.viewSessions ? 'on' : 'off'} · send prompts{' '}
          {grants.sendPrompts ? 'on' : 'off'} · start sessions {grants.startSessions ? 'on' : 'off'}
        </div>
      )}
    </div>
  );
}
