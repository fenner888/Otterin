/**
 * App-level state — deliberately lean: one React context with hooks. Poll
 * driving lives here for the session board (PLAN §6 cadences); a
 * main-process scheduler is planned but not yet wired, so the renderer polls
 * through `window.otterin.invoke` gated on window visibility.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import { sidebarGroup } from './activity-utils';
import type { Bridge } from './bridge';
import { OtterinBridgeError, bridgeErrorCode } from './errors';
import { usePoll, type PollOutcome } from './hooks/usePoll';
import type {
  BoardSession,
  BridgeFeaturesResult,
  BridgeHealth,
  ComputerDiscoveryStatus,
  DiscoveryState,
  PairedComputerSummary,
  PollingMode,
} from './types';

const MAX_PAGES_PER_COMPUTER = 5;
const FEATURES_CACHE_TTL_MS = 60_000;
const PREFS_KEY = 'otterin.mac.prefs.v1';
const DRAFTS_KEY = 'otterin.mac.drafts.v1';
const MAX_DRAFTS = 50;

export const POLL_INTERVALS: Record<
  PollingMode,
  { sessionList: number; history: number; activity: number }
> = {
  battery_saver: { sessionList: 60_000, history: 6_000, activity: 3_000 },
  balanced: { sessionList: 30_000, history: 3_000, activity: 1_500 },
  fast: { sessionList: 15_000, history: 1_500, activity: 1_000 },
};

export type Selection =
  | { kind: 'session'; bridgeId: string; sessionId: string; continued?: boolean }
  | { kind: 'create'; bridgeId: string }
  | { kind: 'settings' }
  | { kind: 'home' };

interface PersistedPrefs {
  pollingMode: PollingMode;
  autoApproveSessions: Record<string, true>;
  modelOverrides: Record<string, string>;
}

function loadPrefs(): PersistedPrefs {
  const fallback: PersistedPrefs = {
    pollingMode: 'balanced',
    autoApproveSessions: {},
    modelOverrides: {},
  };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
    return {
      pollingMode:
        parsed.pollingMode === 'battery_saver' ||
        parsed.pollingMode === 'fast' ||
        parsed.pollingMode === 'balanced'
          ? parsed.pollingMode
          : 'balanced',
      autoApproveSessions:
        parsed.autoApproveSessions && typeof parsed.autoApproveSessions === 'object'
          ? parsed.autoApproveSessions
          : {},
      modelOverrides:
        parsed.modelOverrides && typeof parsed.modelOverrides === 'object'
          ? parsed.modelOverrides
          : {},
    };
  } catch {
    return fallback;
  }
}

function loadDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function stateForError(error: unknown): DiscoveryState {
  const code = bridgeErrorCode(error);
  if (code === 'not_paired' || code === 'permission_denied' || code === 'authorization_failed') {
    return 'authorization_failed';
  }
  if (code === 'invalid_response') return 'invalid_response';
  if (code === 'too_many_sessions') return 'too_many_sessions';
  if (code === 'busy' || code === 'rate_limited') return 'busy';
  return 'unavailable';
}

/** Sidebar ordering: grouped live → waiting → locked → recent, each by recency. */
export function orderBoardSessions(
  sessions: BoardSession[],
  query: string,
): BoardSession[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? sessions.filter((session) => {
        return (
          (session.title ?? '').toLowerCase().includes(normalized) ||
          session.workspaceName.toLowerCase().includes(normalized) ||
          session.computerName.toLowerCase().includes(normalized) ||
          (session.model?.name ?? '').toLowerCase().includes(normalized)
        );
      })
    : sessions;
  const rank = { live: 0, waiting: 1, locked: 2, recent: 3 } as const;
  return [...filtered].sort((a, b) => {
    const groupDelta = rank[sidebarGroup(a)] - rank[sidebarGroup(b)];
    if (groupDelta !== 0) return groupDelta;
    return Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0');
  });
}

export interface AppStore {
  bridge: Bridge;
  computers: PairedComputerSummary[];
  statuses: ComputerDiscoveryStatus[];
  sessions: BoardSession[];
  boardReady: boolean;
  lastBoardAt?: number;
  lastBoardOutcome: PollOutcome;
  selection: Selection;
  selectSession(bridgeId: string, sessionId: string, options?: { continued?: boolean }): void;
  startCreate(bridgeId?: string): void;
  openSettings(): void;
  goHome(): void;
  searchQuery: string;
  setSearchQuery(value: string): void;
  pollingMode: PollingMode;
  setPollingMode(mode: PollingMode): void;
  refreshComputers(): Promise<void>;
  refreshBoard(): Promise<PollOutcome>;
  ensureFeatures(bridgeId: string): Promise<BridgeFeaturesResult>;
  featuresOf(bridgeId: string): BridgeFeaturesResult | undefined;
  healthOf(bridgeId: string): BridgeHealth | undefined;
  draftFor(key: string): string;
  setDraft(key: string, text: string): void;
  autoApproveFor(key: string): boolean;
  setAutoApprove(key: string, on: boolean): void;
  modelOverrideFor(key: string): string | null;
  setModelOverride(key: string, modelId: string | null): void;
  /** Bump after pairing so the board + computer list refetch immediately. */
  poke(): void;
  /** Registered by the mounted transcript; Cmd+K invokes it. */
  scrollTargetRef: MutableRefObject<(() => void) | null>;
  /** Focus target for the sidebar search field; Cmd+F invokes it. */
  searchFocusRef: MutableRefObject<(() => void) | null>;
}

const AppContext = createContext<AppStore | null>(null);

export function useApp(): AppStore {
  const store = useContext(AppContext);
  if (!store) throw new Error('useApp outside AppProvider');
  return store;
}

export function AppProvider({ bridge, children }: { bridge: Bridge; children: ReactNode }) {
  const [computers, setComputers] = useState<PairedComputerSummary[]>([]);
  const [statuses, setStatuses] = useState<ComputerDiscoveryStatus[]>([]);
  const [sessions, setSessions] = useState<BoardSession[]>([]);
  const [boardReady, setBoardReady] = useState(false);
  const [lastBoardAt, setLastBoardAt] = useState<number | undefined>(undefined);
  const [lastBoardOutcome, setLastBoardOutcome] = useState<PollOutcome>('ok');
  const [selection, setSelection] = useState<Selection>({ kind: 'home' });
  const [searchQuery, setSearchQuery] = useState('');
  const [prefs, setPrefs] = useState<PersistedPrefs>(loadPrefs);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const [healthMap, setHealthMap] = useState<Map<string, BridgeHealth>>(new Map());
  const [featuresMap, setFeaturesMap] = useState<Map<string, BridgeFeaturesResult>>(new Map());
  const featuresFetchedAt = useRef<Map<string, number>>(new Map());
  const scrollTargetRef = useRef<(() => void) | null>(null);
  const searchFocusRef = useRef<(() => void) | null>(null);
  const computersRef = useRef(computers);
  computersRef.current = computers;

  const persistPrefs = useCallback((next: PersistedPrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // prefs are best-effort
    }
  }, []);

  const refreshComputers = useCallback(async () => {
    try {
      const list = await bridge.listComputers();
      setComputers(list);
      computersRef.current = list;
    } catch {
      // Registry read failures leave the last list in place.
    }
  }, [bridge]);

  const refreshBoard = useCallback(async (): Promise<PollOutcome> => {
    // Keep the registry fresh on every tick — pairing/unpairing elsewhere is
    // picked up without a second poll loop.
    try {
      const list = await bridge.listComputers();
      setComputers(list);
      computersRef.current = list;
    } catch {
      // Registry read failures leave the last list in place.
    }
    const current = computersRef.current;
    let outcome: PollOutcome = 'ok';
    const nextSessions: BoardSession[] = [];
    const nextStatuses: ComputerDiscoveryStatus[] = [];
    const nextHealth = new Map<string, BridgeHealth>();

    await Promise.all(
      current.map(async (computer) => {
        try {
          const health = await bridge.health(computer.bridgeId);
          nextHealth.set(computer.bridgeId, health);
          if (!health.capabilities.sessionList) {
            nextStatuses.push({
              bridgeId: computer.bridgeId,
              computerName: computer.computerName,
              state: 'session_discovery_off',
            });
            return;
          }
          const seen = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES_PER_COMPUTER; page += 1) {
            const result = await bridge.listSessions(computer.bridgeId, cursor ? { cursor } : {});
            for (const row of result.sessions) {
              if (seen.has(row.id)) {
                throw new OtterinBridgeError('invalid_response', 'Repeated session id');
              }
              seen.add(row.id);
              nextSessions.push({
                ...row,
                bridgeId: computer.bridgeId,
                computerName: computer.computerName,
              });
            }
            if (!result.nextCursor) break;
            if (page === MAX_PAGES_PER_COMPUTER - 1) {
              throw new OtterinBridgeError('too_many_sessions', 'Session page limit exceeded');
            }
            cursor = result.nextCursor;
          }
          nextStatuses.push({
            bridgeId: computer.bridgeId,
            computerName: computer.computerName,
            state: 'ready',
          });
        } catch (error) {
          const state = stateForError(error);
          if (state === 'busy') outcome = 'busy';
          nextStatuses.push({
            bridgeId: computer.bridgeId,
            computerName: computer.computerName,
            state,
          });
        }
      }),
    );

    nextSessions.sort(
      (a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'),
    );
    setSessions(nextSessions);
    setStatuses(nextStatuses);
    setHealthMap(nextHealth);
    setBoardReady(true);
    setLastBoardAt(Date.now());
    setLastBoardOutcome(outcome);
    return outcome;
  }, [bridge]);

  const pollingMode = prefs.pollingMode;
  const hasComputers = computers.length > 0;
  // Bootstrap: fetch the registry once on mount; once at least one computer
  // exists the board poll keeps the registry fresh on every tick.
  useEffect(() => {
    void refreshComputers();
  }, [refreshComputers]);
  usePoll(refreshBoard, POLL_INTERVALS[pollingMode].sessionList, hasComputers);

  const ensureFeatures = useCallback(
    async (bridgeId: string): Promise<BridgeFeaturesResult> => {
      const fetchedAt = featuresFetchedAt.current.get(bridgeId) ?? 0;
      const cached = featuresMap.get(bridgeId);
      if (cached && Date.now() - fetchedAt < FEATURES_CACHE_TTL_MS) return cached;
      const data = await bridge.features(bridgeId, true);
      featuresFetchedAt.current.set(bridgeId, Date.now());
      setFeaturesMap((current) => new Map(current).set(bridgeId, data));
      return data;
    },
    [bridge, featuresMap],
  );

  const featuresOf = useCallback(
    (bridgeId: string) => featuresMap.get(bridgeId),
    [featuresMap],
  );

  const healthOf = useCallback((bridgeId: string) => healthMap.get(bridgeId), [healthMap]);

  const selectSession = useCallback(
    (bridgeId: string, sessionId: string, options?: { continued?: boolean }) => {
      setSelection({ kind: 'session', bridgeId, sessionId, continued: options?.continued });
    },
    [],
  );

  const startCreate = useCallback(
    (bridgeId?: string) => {
      const target =
        bridgeId ??
        (selection.kind === 'session' ? selection.bridgeId : undefined) ??
        statuses.find((status) => status.state === 'ready')?.bridgeId ??
        computers[0]?.bridgeId;
      if (!target) return;
      setSelection({ kind: 'create', bridgeId: target });
    },
    [computers, selection, statuses],
  );

  const openSettings = useCallback(() => setSelection({ kind: 'settings' }), []);
  const goHome = useCallback(() => setSelection({ kind: 'home' }), []);

  const setPollingMode = useCallback(
    (mode: PollingMode) => persistPrefs({ ...prefs, pollingMode: mode }),
    [persistPrefs, prefs],
  );

  const setDraft = useCallback((key: string, text: string) => {
    setDrafts((current) => {
      const next = { ...current };
      if (text) next[key] = text;
      else delete next[key];
      const keys = Object.keys(next);
      while (keys.length > MAX_DRAFTS) {
        const oldest = keys.shift();
        if (oldest) delete next[oldest];
      }
      try {
        window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // drafts are best-effort
      }
      return next;
    });
  }, []);

  const draftFor = useCallback((key: string) => drafts[key] ?? '', [drafts]);

  const setAutoApprove = useCallback(
    (key: string, on: boolean) => {
      const autoApproveSessions = { ...prefs.autoApproveSessions };
      if (on) autoApproveSessions[key] = true;
      else delete autoApproveSessions[key];
      persistPrefs({ ...prefs, autoApproveSessions });
    },
    [persistPrefs, prefs],
  );
  const autoApproveFor = useCallback(
    (key: string) => prefs.autoApproveSessions[key] === true,
    [prefs.autoApproveSessions],
  );

  const setModelOverride = useCallback(
    (key: string, modelId: string | null) => {
      const modelOverrides = { ...prefs.modelOverrides };
      if (modelId) modelOverrides[key] = modelId;
      else delete modelOverrides[key];
      persistPrefs({ ...prefs, modelOverrides });
    },
    [persistPrefs, prefs],
  );
  const modelOverrideFor = useCallback(
    (key: string) => prefs.modelOverrides[key] ?? null,
    [prefs.modelOverrides],
  );

  const poke = useCallback(() => {
    void refreshComputers().then(() => refreshBoard());
  }, [refreshBoard, refreshComputers]);

  const value = useMemo<AppStore>(
    () => ({
      bridge,
      computers,
      statuses,
      sessions,
      boardReady,
      lastBoardAt,
      lastBoardOutcome,
      selection,
      selectSession,
      startCreate,
      openSettings,
      goHome,
      searchQuery,
      setSearchQuery,
      pollingMode,
      setPollingMode,
      refreshComputers,
      refreshBoard,
      ensureFeatures,
      featuresOf,
      healthOf,
      draftFor,
      setDraft,
      autoApproveFor,
      setAutoApprove,
      modelOverrideFor,
      setModelOverride,
      poke,
      scrollTargetRef,
      searchFocusRef,
    }),
    [
      autoApproveFor,
      boardReady,
      computers,
      draftFor,
      ensureFeatures,
      featuresOf,
      goHome,
      healthOf,
      lastBoardAt,
      lastBoardOutcome,
      modelOverrideFor,
      openSettings,
      poke,
      pollingMode,
      refreshBoard,
      refreshComputers,
      searchQuery,
      selectSession,
      selection,
      sessions,
      setAutoApprove,
      setDraft,
      setModelOverride,
      setPollingMode,
      startCreate,
      statuses,
      bridge,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
