/**
 * Session view — header (title, workspace, model chip, state chip, Stop when
 * live), transcript, interaction dock, then composer / locked panel /
 * read-only bar by session state.
 */
import { useRef, useState } from 'react';
import clsx from 'clsx';

import { activityShortLabel, awaitingLabel } from '../activity-utils';
import { useSessionController } from '../useSession';
import { useModelCatalog } from '../useModelCatalog';
import { useApp, type Selection } from '../store';
import { Composer, ReadOnlyComposerBar, type ModelCatalogState } from './Composer';
import { Icon } from './Icon';
import { InteractionDock } from './InteractionDock';
import { LockedPanel } from './LockedPanel';
import { Transcript, type TranscriptHandle } from './Transcript';

function StateChip({
  locked,
  awaiting,
  liveTurn,
  busy,
  ownerName,
}: {
  locked: boolean;
  awaiting: 'answer' | 'approval' | undefined;
  liveTurn: boolean;
  busy: boolean;
  ownerName: string | undefined;
}) {
  if (locked) {
    return (
      <span className="flex items-center rounded-chip bg-tintOrange px-pillX py-pillY text-[11px] font-medium text-blocked">
        <Icon name="lock" size={10} className="mr-1" />
        Open in another Devin client on this Mac{ownerName ? ` (${ownerName})` : ''}
      </span>
    );
  }
  if (awaiting) {
    return (
      <span className="flex items-center rounded-chip bg-tintOrange px-pillX py-pillY text-[11px] font-medium text-blocked">
        <span className="mr-1 h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-blocked" />
        {awaitingLabel(awaiting)}
      </span>
    );
  }
  if (liveTurn) {
    return (
      <span className="flex items-center rounded-chip bg-tintBlue px-pillX py-pillY text-[11px] font-medium text-running">
        <span className="mr-1 h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-running" />
        Live via Connector
      </span>
    );
  }
  if (busy) {
    return (
      <span className="flex items-center rounded-chip bg-tintBlue px-pillX py-pillY text-[11px] font-medium text-running">
        <span className="mr-1 h-1.5 w-1.5 animate-otterin-pulse rounded-dot bg-running" />
        Working elsewhere
      </span>
    );
  }
  return (
    <span className="rounded-chip bg-tintSecondary px-pillX py-pillY text-[11px] text-textMid">
      Free
    </span>
  );
}

export function SessionView({
  selection,
}: {
  selection: Extract<Selection, { kind: 'session' }>;
}) {
  const { bridgeId, sessionId } = selection;
  const store = useApp();
  const controller = useSessionController(bridgeId, sessionId);
  const catalogState = useModelCatalog(bridgeId);
  const transcriptRef = useRef<TranscriptHandle>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const continued = selection.continued === true;
  const computerName =
    store.computers.find((computer) => computer.bridgeId === bridgeId)?.computerName ??
    'this Mac';
  const row = store.sessions.find(
    (candidate) => candidate.bridgeId === bridgeId && candidate.id === sessionId,
  );

  const title =
    row?.title ??
    (row?.hasTitle ? 'Session title hidden' : controller.loaded?.session.workspaceName ?? row?.workspaceName ?? 'Local session');
  const workspaceName = controller.loaded?.session.workspaceName ?? row?.workspaceName ?? '';
  const modelName =
    catalogState.options?.models.find((model) => model.id === controller.selectedModelId)?.name ??
    controller.loaded?.session.model?.name ??
    row?.model?.name;
  const activitySupported = store.featuresOf(bridgeId)?.activityTimeline !== false;
  const grants = store.featuresOf(bridgeId)?.presentation?.grants;

  const catalog: ModelCatalogState = {
    models: catalogState.options?.models ?? [],
    loading: catalogState.loading,
    error: catalogState.error,
    catalogSource: catalogState.options?.catalogSource,
    refreshing: catalogState.refreshing,
    refreshError: catalogState.refreshError,
    open: catalogState.open,
    refresh: catalogState.refresh,
  };

  // Cmd+K scroll target — registered on window by the app shell.
  store.scrollTargetRef.current = () => transcriptRef.current?.scrollToBottom();

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface0">
      {/* hiddenInset top inset: header content sits left of the drag strip. */}
      <div className="titlebar-drag flex h-11 shrink-0 items-center border-b border-borderSubtle pl-4 pr-3">
        <div className="titlebar-no-drag flex min-w-0 flex-1 items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[14px] font-medium text-textHi" title={title}>
                {title}
              </h1>
              <StateChip
                locked={controller.locked}
                awaiting={controller.awaiting}
                liveTurn={controller.liveTurn !== null}
                busy={controller.busy}
                ownerName={controller.ownerName}
              />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-textLow">
              <Icon name="desktop" size={10} />
              <span className="truncate">{computerName}</span>
              {workspaceName && (
                <>
                  <span>·</span>
                  <Icon name="folder" size={10} />
                  <span className="truncate">{workspaceName}</span>
                </>
              )}
              {modelName && (
                <>
                  <span>·</span>
                  <span className="truncate">{modelName}</span>
                </>
              )}
              {controller.busy && controller.activity?.kind && !controller.awaiting && (
                <>
                  <span>·</span>
                  <span className="text-textMid">
                    {activityShortLabel(controller.activity.kind)}
                  </span>
                </>
              )}
            </div>
          </div>
          {controller.busy && controller.canCancel && (
            <button
              type="button"
              className="ml-3 flex shrink-0 items-center rounded-chip bg-destructive px-3 py-1.5 text-[12px] font-medium text-textAlwaysWhite hover:opacity-90"
              onClick={() => void controller.stop()}
              title="Stop the connector-owned turn"
            >
              <Icon name="stop" size={11} className="mr-1.5" />
              Stop
            </button>
          )}
        </div>
      </div>

      {controller.loadState === 'loading' ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="h-2 w-2 animate-otterin-pulse rounded-dot bg-brand" />
          <span className="ml-2 text-[13px] text-textMid">Loading from {computerName}…</span>
        </div>
      ) : controller.loadState === 'error' || !controller.loaded ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8">
          <Icon name="desktop" size={28} className="text-textLow" />
          <div className="mt-4 text-center text-[16px] text-textHi">
            Could not load local history
          </div>
          <div className="mt-2 max-w-md text-center text-[13px] leading-5 text-textMid">
            {controller.loadError}
          </div>
          <button
            type="button"
            className="mt-5 rounded-card bg-brand px-5 py-2.5 text-[14px] font-medium text-textAlwaysWhite"
            onClick={controller.refresh}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <Transcript
            ref={transcriptRef}
            loaded={controller.loaded}
            activitySupported={activitySupported}
            liveTurn={controller.liveTurn}
            externalLive={controller.externalLive}
            pendingText={controller.pendingText}
            continued={continued}
            steering={controller.steering}
          />
          <InteractionDock
            answeredSummary={controller.answeredSummary}
            elicitation={controller.elicitation}
            permission={controller.permission}
            terminalQuestions={controller.terminalQuestions}
            responding={controller.responding}
            respondError={controller.respondError}
            computerName={computerName}
            onElicitation={(answer) => void controller.respondElicitation(answer)}
            onPermission={(decision) => void controller.respondPermission(decision)}
          />
          {controller.locked ? (
            <LockedPanel
              draft={controller.draft}
              setDraft={controller.setDraft}
              send={() => void controller.send()}
              sending={controller.sending}
              ownerName={controller.ownerName}
              promptError={controller.promptError}
              onOpenDevin={() => controllerOpenDevin(store)}
            />
          ) : controller.canPrompt ? (
            <Composer
              draft={controller.draft}
              setDraft={controller.setDraft}
              send={() => void controller.send()}
              sending={controller.sending}
              busy={controller.busy}
              canCancel={controller.canCancel}
              stop={() => void controller.stop()}
              terminalHint={controller.terminalHint}
              promptError={controller.promptError}
              cancelError={controller.cancelError}
              catalog={catalog}
              selectedModelId={controller.selectedModelId}
              onSelectModel={controller.setModel}
              sessionModelName={modelName}
              autoApproveSupported={controller.autoApproveSupported}
              autoApprove={controller.autoApprove}
              toggleAutoApprove={controller.toggleAutoApprove}
              workspaceName={workspaceName}
            />
          ) : (
            <ReadOnlyComposerBar
              grants={grants}
              computerName={computerName}
              onViewPermissions={() => setPermissionsOpen(true)}
            />
          )}
        </>
      )}

      {permissionsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
          onClick={() => setPermissionsOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-sheet border border-border bg-surface2 px-5 py-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-[14px] font-medium text-textHi">
              Permissions on {computerName}
            </div>
            <div className="mt-3 space-y-2 text-[13px]">
              {(
                [
                  ['View sessions', grants?.viewSessions ?? true],
                  ['Send prompts', grants?.sendPrompts ?? false],
                  ['Start sessions', grants?.startSessions ?? false],
                ] as const
              ).map(([label, enabled]) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-textMid">{label}</span>
                  <span
                    className={clsx(
                      'rounded-chip px-2 py-0.5 text-[11px] font-medium',
                      enabled ? 'bg-tintGreen text-finished' : 'bg-tintSecondary text-textLow',
                    )}
                  >
                    {enabled ? 'On' : 'Off'}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] leading-4 text-textLow">
              Grants are managed per device in Otterin Connector on {computerName}.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded-chip bg-brand px-4 py-1.5 text-[13px] font-medium text-textAlwaysWhite"
                onClick={() => setPermissionsOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

async function controllerOpenDevin(store: ReturnType<typeof useApp>): Promise<void> {
  await store.bridge.openDevin();
}
