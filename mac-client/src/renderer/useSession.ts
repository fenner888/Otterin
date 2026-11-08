/**
 * Per-open-session controller: owns the transcript load, the live activity
 * poll, pending interactions, composer/draft state, and mutations
 * (prompt/cancel/respond). Mirrors the iPhone computer-session screen logic
 * with desktop cadences from PLAN §6.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  cancelErrorMessage,
  OtterinBridgeError,
  bridgeErrorCode,
  promptErrorMessage,
  publicErrorMessage,
} from './errors';
import { usePoll, type PollOutcome } from './hooks/usePoll';
import { POLL_INTERVALS, useApp } from './store';
import type {
  ElicitationAnswer,
  ElicitationInteraction,
  LoadedSession,
  PermissionDecision,
  SessionActivity,
  SessionPermission,
  TerminalQuestion,
  TurnSnapshot,
} from './types';

export type LoadState = 'loading' | 'ready' | 'error';

export interface SessionController {
  loaded: LoadedSession | undefined;
  loadState: LoadState;
  loadError: string | undefined;
  activity: SessionActivity | undefined;
  elicitation: ElicitationInteraction | null;
  permission: SessionPermission | null;
  answeredSummary: string | null;
  liveTurn: TurnSnapshot | null;
  /** active && !turn — a turn driven by another Devin client. */
  externalLive: boolean;
  busy: boolean;
  awaiting: 'answer' | 'approval' | undefined;
  terminalQuestions: TerminalQuestion[];
  terminalHint: string | null;
  locked: boolean;
  ownerName: string | undefined;
  canPrompt: boolean;
  canCancel: boolean;
  autoApproveSupported: boolean;
  autoApprove: boolean;
  selectedModelId: string | null;
  draft: string;
  pendingText: string | null;
  sending: boolean;
  steering: boolean;
  promptError: string | null;
  cancelError: string | null;
  responding: boolean;
  respondError: string | null;
  setDraft(text: string): void;
  send(): Promise<void>;
  stop(): Promise<void>;
  respondElicitation(answer: ElicitationAnswer): Promise<void>;
  respondPermission(decision: PermissionDecision): Promise<void>;
  setModel(modelId: string | null): void;
  toggleAutoApprove(): void;
  refresh(): void;
}

function outcomeFor(error: unknown): PollOutcome {
  const code = bridgeErrorCode(error);
  if (code === 'busy' || code === 'conflict') return 'busy';
  if (code === 'rate_limited') return 'rate_limited';
  return 'error';
}

function elicitationSummaryText(
  answer: ElicitationAnswer,
  interaction: ElicitationInteraction | null,
): string {
  if (answer.action !== 'accept' || !interaction) return 'You skipped this question';
  const values = interaction.fields.flatMap((field) => {
    const value = answer.content[field.key];
    if (value === undefined) return [];
    if (Array.isArray(value)) {
      return value.map(
        (item) => field.options?.find((option) => option.value === item)?.label ?? item,
      );
    }
    if (typeof value === 'boolean') return [value ? 'Yes' : 'No'];
    return [field.options?.find((option) => option.value === String(value))?.label ?? String(value)];
  });
  return `You answered · ${values.join(', ') || 'Answered'}`.slice(0, 200);
}

function permissionSummaryText(decision: PermissionDecision): string {
  switch (decision) {
    case 'allow_once':
      return 'You allowed this command once';
    case 'allow_session':
      return 'You allowed this command for this session';
    case 'reject_once':
      return 'You denied this command';
  }
}

export function useSessionController(bridgeId: string, sessionId: string): SessionController {
  const store = useApp();
  const { bridge } = store;
  const sessionKey = `${bridgeId}:${sessionId}`;
  const computerName =
    store.computers.find((computer) => computer.bridgeId === bridgeId)?.computerName ??
    'this Mac';

  const [loaded, setLoaded] = useState<LoadedSession | undefined>(undefined);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<SessionActivity | undefined>(undefined);
  const [elicitation, setElicitation] = useState<ElicitationInteraction | null>(null);
  const [permission, setPermission] = useState<SessionPermission | null>(null);
  const [answeredSummary, setAnsweredSummary] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [steering, setSteering] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [featuresFetched, setFeaturesFetched] = useState(false);
  const [timestampsWanted, setTimestampsWanted] = useState(false);

  const draft = store.draftFor(sessionKey);
  const selectedModelId = store.modelOverrideFor(sessionKey);
  const autoApprove = store.autoApproveFor(sessionKey);

  const generation = useRef(0);
  const wasActiveRef = useRef<boolean | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current += 1;
    },
    [],
  );

  const features = store.featuresOf(bridgeId);
  const health = store.healthOf(bridgeId);
  const row = useMemo(
    () =>
      store.sessions.find(
        (candidate) => candidate.bridgeId === bridgeId && candidate.id === sessionId,
      ),
    [bridgeId, sessionId, store.sessions],
  );

  // Fetch features once per mount (store caches 60 s per bridgeId).
  useEffect(() => {
    let cancelled = false;
    store
      .ensureFeatures(bridgeId)
      .then((data) => {
        if (cancelled) return;
        setTimestampsWanted(data.presentation?.messageTimestamps === true);
        setFeaturesFetched(true);
      })
      .catch(() => {
        if (!cancelled) setFeaturesFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeId, store]);

  const doLoad = useCallback(async (): Promise<PollOutcome> => {
    try {
      const data = await bridge.loadSession(bridgeId, sessionId, {
        timestamps: timestampsWanted,
      });
      if (!mounted.current) return 'ok';
      setLoaded(data);
      setLoadState('ready');
      setLoadError(undefined);
      setPendingText((current) => {
        if (current === null) return null;
        return data.messages.some(
          (message) => message.source === 'user' && message.text === current,
        )
          ? null
          : current;
      });
      return 'ok';
    } catch (error) {
      if (!mounted.current) return outcomeFor(error);
      setLoadState((state) => (state === 'ready' ? state : 'error'));
      setLoadError(publicErrorMessage(error));
      return outcomeFor(error);
    }
  }, [bridge, bridgeId, sessionId, timestampsWanted]);

  const doActivity = useCallback(async (): Promise<PollOutcome> => {
    try {
      const data = await bridge.sessionActivity(bridgeId, sessionId);
      if (!mounted.current) return 'ok';
      setActivity((previous) => {
        wasActiveRef.current = previous?.active;
        return data;
      });
      return 'ok';
    } catch (error) {
      return outcomeFor(error);
    }
  }, [bridge, bridgeId, sessionId]);

  const awaiting = activity?.awaiting;

  const doInteractions = useCallback(async (): Promise<PollOutcome> => {
    let outcome: PollOutcome = 'ok';
    if (features?.permissionPrompts !== false) {
      try {
        const result = await bridge.sessionPermission(bridgeId, sessionId);
        if (mounted.current) setPermission(result.permission);
      } catch (error) {
        outcome = outcomeFor(error);
      }
    }
    if (features?.sessionElicitation === true) {
      try {
        const result = await bridge.sessionElicitation(bridgeId, sessionId);
        if (mounted.current) setElicitation(result.interaction);
      } catch (error) {
        if (outcome === 'ok') outcome = outcomeFor(error);
      }
    }
    return outcome;
  }, [bridge, bridgeId, features, sessionId]);

  const intervals = POLL_INTERVALS[store.pollingMode];
  const busy = activity?.active === true;

  // Live-turn end → one committed transcript refresh (§4 turn-end rule).
  useEffect(() => {
    if (wasActiveRef.current === true && activity && activity.active === false) {
      void doLoad();
    }
  }, [activity, doLoad]);

  // Activity poll: fast while a turn or interaction is live, relaxed when idle.
  usePoll(doActivity, busy || awaiting ? intervals.activity : intervals.history, true);
  // Committed-state refresh while anything is driving this session.
  usePoll(doLoad, intervals.history, featuresFetched && busy);
  // Pending interactions only while `awaiting` is set — each method has its
  // own rate bucket, so they share the activity cadence.
  usePoll(doInteractions, intervals.activity, awaiting !== undefined);

  // Answered-summary retirement mirrors iPhone: a new interaction key clears it.
  const interactionKey = elicitation
    ? `elicitation:${elicitation.id}`
    : permission
      ? `permission:${permission.id}`
      : activity?.terminalQuestion
        ? `terminal:${activity.terminalQuestion.questions.length}`
        : null;
  const previousInteractionKey = useRef<string | null>(null);
  useEffect(() => {
    if (interactionKey && interactionKey !== previousInteractionKey.current) {
      setAnsweredSummary(null);
    }
    previousInteractionKey.current = interactionKey;
  }, [interactionKey]);

  const liveTurn = activity?.active && activity.turn ? activity.turn : null;
  const externalLive = busy && !liveTurn;
  const terminalQuestions =
    awaiting === 'answer' && activity?.terminalQuestion ? activity.terminalQuestion.questions : [];

  const owner = loaded?.session.owner ?? row?.owner;
  const ownerName = loaded?.session.ownerName ?? row?.ownerName;
  const locked =
    owner === 'locked_external' ||
    (owner === undefined &&
      ((row?.activity !== undefined && row.activity.active === false && !busy) ||
        (busy && !liveTurn)));

  const grants = features?.presentation?.grants;
  const canPrompt =
    (health?.capabilities.sessionPrompt ?? true) && (grants ? grants.sendPrompts : true);
  const canCancel = features?.sessionCancel === true && liveTurn !== null;
  const autoApproveSupported = features?.autoApprove === true;
  const terminalHint =
    terminalQuestions.length > 0 ? 'Answer in Terminal on this Mac' : null;

  const setDraft = useCallback(
    (text: string) => store.setDraft(sessionKey, text),
    [sessionKey, store],
  );

  const send = useCallback(async () => {
    const text = store.draftFor(sessionKey).trim();
    // Locked/busy are intentionally not gated here — the locked panel's
    // "Continue in a new session" must send on the locked session and let
    // the bridge fork; a genuine conflict surfaces as a mapped 409 error.
    if (!text || sending) return;
    setPromptError(null);
    setCancelError(null);
    setAnsweredSummary(null);
    setPendingText(text);
    store.setDraft(sessionKey, '');
    setSending(true);
    try {
      const result = await bridge.promptSession(bridgeId, sessionId, {
        text,
        ...(selectedModelId ? { modelId: selectedModelId } : {}),
        ...(autoApproveSupported ? { autoApprove: autoApprove } : {}),
      });
      if (!mounted.current) return;
      if (result.sessionId && result.sessionId !== sessionId) {
        // Transparent continuation — navigate to the forked session.
        setPendingText(null);
        store.selectSession(bridgeId, result.sessionId, { continued: true });
        void store.refreshBoard();
        return;
      }
      setSteering(true);
      void doActivity();
    } catch (error) {
      if (!mounted.current) return;
      setPromptError(promptErrorMessage(error, computerName));
      store.setDraft(sessionKey, text);
      setPendingText(null);
    } finally {
      if (mounted.current) setSending(false);
    }
  }, [
    autoApprove,
    autoApproveSupported,
    bridge,
    bridgeId,
    computerName,
    doActivity,
    selectedModelId,
    sending,
    sessionId,
    sessionKey,
    store,
  ]);

  const stop = useCallback(async () => {
    setCancelError(null);
    try {
      await bridge.cancelSession(bridgeId, sessionId);
      if (!mounted.current) return;
      setSteering(false);
      setPendingText(null);
      void doActivity();
    } catch (error) {
      if (mounted.current) setCancelError(cancelErrorMessage(error, computerName));
    }
  }, [bridge, bridgeId, computerName, doActivity, sessionId]);

  const respondElicitation = useCallback(
    async (answer: ElicitationAnswer) => {
      setRespondError(null);
      setResponding(true);
      try {
        await bridge.respondElicitation(bridgeId, sessionId, answer);
        if (!mounted.current) return;
        setAnsweredSummary(elicitationSummaryText(answer, elicitation));
        setElicitation(null);
        setSteering(true);
        void doActivity();
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof OtterinBridgeError && error.code === 'authorization_failed') {
          // First responder wins — another device may have answered.
          setElicitation(null);
        } else {
          setRespondError('Your answer could not be sent securely. Try again.');
        }
      } finally {
        if (mounted.current) setResponding(false);
      }
    },
    [bridge, bridgeId, doActivity, elicitation, sessionId],
  );

  const respondPermission = useCallback(
    async (decision: PermissionDecision) => {
      if (!permission) return;
      setRespondError(null);
      setResponding(true);
      try {
        await bridge.respondPermission(bridgeId, sessionId, {
          permissionId: permission.id,
          decision,
        });
        if (!mounted.current) return;
        setAnsweredSummary(permissionSummaryText(decision));
        setPermission(null);
        setSteering(true);
        void doActivity();
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof OtterinBridgeError && error.code === 'authorization_failed') {
          setPermission(null);
        } else {
          setRespondError('Your decision could not be sent securely. Try again.');
        }
      } finally {
        if (mounted.current) setResponding(false);
      }
    },
    [bridge, bridgeId, doActivity, permission, sessionId],
  );

  const setModel = useCallback(
    (modelId: string | null) => store.setModelOverride(sessionKey, modelId),
    [sessionKey, store],
  );

  const toggleAutoApprove = useCallback(
    () => store.setAutoApprove(sessionKey, !autoApprove),
    [autoApprove, sessionKey, store],
  );

  const refresh = useCallback(() => {
    setLoadState('loading');
    void doLoad();
    void doActivity();
    void store.refreshBoard();
  }, [doActivity, doLoad, store]);

  return {
    loaded,
    loadState,
    loadError,
    activity,
    elicitation,
    permission,
    answeredSummary,
    liveTurn,
    externalLive,
    busy,
    awaiting,
    terminalQuestions,
    terminalHint,
    locked,
    ownerName,
    canPrompt,
    canCancel,
    autoApproveSupported,
    autoApprove,
    selectedModelId,
    draft,
    pendingText,
    sending,
    steering,
    promptError,
    cancelError,
    responding,
    respondError,
    setDraft,
    send,
    stop,
    respondElicitation,
    respondPermission,
    setModel,
    toggleAutoApprove,
    refresh,
  };
}
