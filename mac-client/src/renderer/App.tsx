/**
 * App shell — AppProvider + Sidebar + content pane with keyboard shortcuts
 * (Cmd+N create, Cmd+F search, Cmd+K transcript tail, Cmd+1..9 session jump)
 * and the onboarding gate when no computer is paired.
 */
import { useEffect, useMemo, useState } from 'react';

import { initBridge, type Bridge } from './bridge';
import { publicErrorMessage } from './errors';
import { orderBoardSessions, AppProvider, useApp } from './store';
import { Icon } from './components/Icon';
import { NewSessionView } from './components/NewSessionView';
import { Onboarding } from './components/Onboarding';
import { SessionView } from './components/SessionView';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';

function EmptyState() {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center bg-surface0">
      <div className="titlebar-drag fixed inset-x-0 top-0 h-12" />
      <Icon name="desktop" size={36} className="text-textLow" />
      <div className="mt-4 text-[15px] text-textMid">Select a session</div>
      <div className="mt-1.5 text-[12px] text-textLow">
        or press <kbd className="rounded border border-borderSubtle px-1">⌘N</kbd> to start a new
        one
      </div>
    </div>
  );
}

function Shell() {
  const store = useApp();
  const [rePairing, setRePairing] = useState(false);
  const ordered = useMemo(
    () => orderBoardSessions(store.sessions, store.searchQuery),
    [store.sessions, store.searchQuery],
  );
  const selection = store.selection;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        store.startCreate();
      } else if (key === 'f') {
        event.preventDefault();
        store.searchFocusRef.current?.();
      } else if (key === 'k') {
        event.preventDefault();
        store.scrollTargetRef.current?.();
      } else if (key >= '1' && key <= '9') {
        const session = ordered[Number(key) - 1];
        if (session) {
          event.preventDefault();
          store.selectSession(session.bridgeId, session.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ordered, store]);

  // Bootstrap gate: registry fetch finished and no paired computer → onboarding.
  const needsOnboarding = store.boardReady && store.computers.length === 0;

  return (
    <div className="flex h-screen overflow-hidden bg-surface0 text-textHi">
      {needsOnboarding || rePairing ? (
        <Onboarding
          onDone={() => {
            setRePairing(false);
            void store.refreshBoard();
          }}
        />
      ) : (
        <>
          <Sidebar ordered={ordered} selection={selection} />
          {selection.kind === 'session' ? (
            <SessionView
              key={`${selection.bridgeId}:${selection.sessionId}`}
              selection={selection}
            />
          ) : selection.kind === 'create' ? (
            <NewSessionView key={selection.bridgeId} bridgeId={selection.bridgeId} />
          ) : selection.kind === 'settings' ? (
            <SettingsView onRePair={() => setRePairing(true)} />
          ) : (
            <EmptyState />
          )}
        </>
      )}
    </div>
  );
}

export function App() {
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    initBridge()
      .then(setBridge)
      .catch((error: unknown) => setInitError(publicErrorMessage(error)));
  }, []);

  if (initError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface0 px-8 text-textHi">
        <Icon name="alert" size={28} className="text-failed" />
        <div className="mt-4 text-[15px]">Otterin could not start</div>
        <div className="mt-2 max-w-md text-center text-[13px] leading-5 text-textMid">
          {initError}
        </div>
      </div>
    );
  }
  if (!bridge) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface0">
        <span className="h-2 w-2 animate-otterin-pulse rounded-dot bg-brand" />
      </div>
    );
  }
  return (
    <AppProvider bridge={bridge}>
      <Shell />
    </AppProvider>
  );
}
