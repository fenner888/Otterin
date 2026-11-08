// Main-process poll scheduler (PLAN §6).
//
// Lives in main on purpose: the rate budget is process-global, the cadence
// is window-visibility aware, and the background list-only poll keeps the
// Dock badge / notifications honest while the window is hidden — renderer
// timers would be Chromium-throttled anyway.
//
// Cadences (this slice):
//   session.list      30 s foreground / 30 s background (window hidden
//                     keeps list-only polling for badge + notifications)
//   session.activity  1.5 s while a bridge-owned turn is live on the open
//                     session, 3 s while the session is open but idle
//   jitter            ±10 % on every scheduled delay
//
// Back-off (PLAN §6):
//   429 busy         -> one retry after ~400 ms, then normal cadence
//   429 rate_limited -> double the interval, capped at 30 s, plus jitter
//   503              -> a single 503 never means "offline"; >=3 consecutive
//                       marks the bridge unavailable until a success
//   single-flight    -> one in-flight request per kind per bridge/session
//
// This module is electron-free: index.ts feeds it visibility transitions
// and wires its pending-interaction output to notifications + the Dock.

import {
  activitySummarySchema,
  bridgeErrorCode,
  isLiveBridgeTurn,
  pendingInteractionsForPage,
  sessionPageSnapshotSchema,
  type ActivitySummary,
  type PendingInteraction,
  type ResolveBridgeConnection,
  type SessionPageSnapshot,
} from './bridge-client';

export const LIST_POLL_MS = 30_000;
export const ACTIVITY_LIVE_MS = 1_500;
export const ACTIVITY_IDLE_MS = 3_000;
const BUSY_RETRY_MS = 400;
const RATE_LIMIT_CAP_MS = 30_000;
const OFFLINE_STREAK = 3;
const JITTER_RATIO = 0.1;

export type BridgePollState = 'unknown' | 'online' | 'unavailable';

export interface BridgeSnapshot {
  state: BridgePollState;
  page: SessionPageSnapshot | null;
  /** Error code from the last failed poll, when state is 'unavailable'. */
  lastErrorCode: string | null;
}

export interface OpenSessionSnapshot {
  bridgeId: string;
  sessionId: string;
  activity: ActivitySummary | null;
  /** Same unavailable-streak semantics as the bridge row. */
  state: BridgePollState;
}

export interface SchedulerSnapshot {
  bridges: Record<string, BridgeSnapshot>;
  openSession: OpenSessionSnapshot | null;
  pendingCount: number;
  updatedAt: number;
}

interface SchedulerDeps {
  resolveConnection: ResolveBridgeConnection;
  onPending: (pending: PendingInteraction[]) => void;
  now?: () => number;
  setTimeout?: typeof setTimeout;
}

interface BridgeRuntime {
  state: BridgePollState;
  page: SessionPageSnapshot | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  listInFlight: boolean;
  listBackoffUntil: number;
  rateLimited: boolean;
}

interface OpenSessionRuntime {
  bridgeId: string;
  sessionId: string;
  activity: ActivitySummary | null;
  state: BridgePollState;
  consecutiveFailures: number;
  inFlight: boolean;
  busyRetried: boolean;
}

function jitter(delay: number): number {
  const delta = delay * JITTER_RATIO;
  return Math.round(delay - delta + Math.random() * delta * 2);
}

export class PollScheduler {
  private readonly resolveConnection: ResolveBridgeConnection;
  private readonly onPending: (pending: PendingInteraction[]) => void;
  private readonly now: () => number;
  private readonly timer: typeof setTimeout;

  private foreground = true;
  private bridgeIds: string[] = [];
  private bridges = new Map<string, BridgeRuntime>();
  private openSession: OpenSessionRuntime | null = null;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(deps: SchedulerDeps) {
    this.resolveConnection = deps.resolveConnection;
    this.onPending = deps.onPending;
    this.now = deps.now ?? Date.now;
    this.timer = deps.setTimeout ?? setTimeout;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleListPoll(0);
    this.scheduleActivityPoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.listTimer !== null) {
      clearTimeout(this.listTimer);
      this.listTimer = null;
    }
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  /** Which bridges the scheduler may poll — fed from computers:list. */
  setBridgeIds(bridgeIds: string[]): void {
    this.bridgeIds = [...bridgeIds];
    for (const key of [...this.bridges.keys()]) {
      if (!this.bridgeIds.includes(key)) {
        this.bridges.delete(key);
      }
    }
  }

  /** Window visibility/focus — blur or hide drops to background cadence. */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) {
      return;
    }
    this.foreground = foreground;
    if (this.running) {
      this.scheduleListPoll(0);
    }
  }

  /** The session the renderer has open, or null when none. */
  setOpenSession(bridgeId: string, sessionId: string | null): void {
    if (sessionId === null) {
      this.openSession = null;
      return;
    }
    if (this.openSession?.sessionId === sessionId && this.openSession.bridgeId === bridgeId) {
      return;
    }
    this.openSession = {
      bridgeId,
      sessionId,
      activity: null,
      state: 'unknown',
      consecutiveFailures: 0,
      inFlight: false,
      busyRetried: false,
    };
    if (this.running) {
      this.scheduleActivityPoll(0);
    }
  }

  /** Force the next poll cycle immediately (renderer "refresh" affordance). */
  pollNow(): void {
    if (!this.running) {
      return;
    }
    this.scheduleListPoll(0);
    this.scheduleActivityPoll(0);
  }

  getSnapshot(): SchedulerSnapshot {
    const bridges: Record<string, BridgeSnapshot> = {};
    for (const [bridgeId, runtime] of this.bridges) {
      bridges[bridgeId] = {
        state: runtime.state,
        page: runtime.page,
        lastErrorCode: runtime.lastErrorCode,
      };
    }
    return {
      bridges,
      openSession: this.openSession
        ? {
            bridgeId: this.openSession.bridgeId,
            sessionId: this.openSession.sessionId,
            activity: this.openSession.activity,
            state: this.openSession.state,
          }
        : null,
      pendingCount: this.currentPending().length,
      updatedAt: this.now(),
    };
  }

  // -- internals ------------------------------------------------------------

  private runtimeFor(bridgeId: string): BridgeRuntime {
    let runtime = this.bridges.get(bridgeId);
    if (!runtime) {
      runtime = {
        state: 'unknown',
        page: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        listInFlight: false,
        listBackoffUntil: 0,
        rateLimited: false,
      };
      this.bridges.set(bridgeId, runtime);
    }
    return runtime;
  }

  private scheduleListPoll(delay: number): void {
    if (!this.running) {
      return;
    }
    if (this.listTimer !== null) {
      clearTimeout(this.listTimer);
    }
    const effective = delay === 0 ? 0 : jitter(delay);
    this.listTimer = this.timer(() => {
      void this.runListCycle();
    }, effective);
  }

  private scheduleActivityPoll(delay: number): void {
    if (!this.running) {
      return;
    }
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer);
    }
    const effective = delay === 0 ? 0 : jitter(delay);
    this.activityTimer = this.timer(() => {
      void this.runActivityPoll();
    }, effective);
  }

  private listInterval(runtime: BridgeRuntime): number {
    const base = runtime.rateLimited ? RATE_LIMIT_CAP_MS : LIST_POLL_MS;
    return Math.min(base, RATE_LIMIT_CAP_MS);
  }

  private async runListCycle(): Promise<void> {
    if (!this.running) {
      return;
    }
    // Sequential across bridges — keeps <=2 requests in flight per client
    // (PLAN §5 rate-budget headroom).
    for (const bridgeId of this.bridgeIds) {
      const runtime = this.runtimeFor(bridgeId);
      if (runtime.listInFlight || this.now() < runtime.listBackoffUntil) {
        continue;
      }
      runtime.listInFlight = true;
      try {
        const connection = await this.resolveConnection(bridgeId);
        const page = sessionPageSnapshotSchema.parse(await connection.listSessions());
        runtime.page = page;
        runtime.state = 'online';
        runtime.lastErrorCode = null;
        runtime.consecutiveFailures = 0;
        runtime.rateLimited = false;
      } catch (error) {
        this.recordFailure(runtime, error);
      } finally {
        runtime.listInFlight = false;
      }
    }
    this.emitPending();
    if (this.running) {
      // Foreground and background cadence are both 30 s in v1 — the flag
      // exists so a "fast" polling-mode setting can split them later.
      const slowest = [...this.bridges.values()].reduce(
        (acc, runtime) => Math.max(acc, this.listInterval(runtime)),
        LIST_POLL_MS,
      );
      this.scheduleListPoll(slowest);
    }
  }

  private async runActivityPoll(): Promise<void> {
    if (!this.running) {
      return;
    }
    const open = this.openSession;
    if (!open) {
      return;
    }
    if (!open.inFlight) {
      open.inFlight = true;
      try {
        const connection = await this.resolveConnection(open.bridgeId);
        const summary = activitySummarySchema.parse(
          await connection.getSessionActivity(open.sessionId),
        );
        open.activity = summary;
        open.state = 'online';
        open.consecutiveFailures = 0;
      } catch (error) {
        const code = bridgeErrorCode(error);
        if (code === 'busy' && !open.busyRetried) {
          // PLAN §6: 429 busy -> one retry ~400 ms, then normal cadence.
          open.busyRetried = true;
          open.inFlight = false;
          this.scheduleActivityPoll(BUSY_RETRY_MS);
          return;
        }
        open.busyRetried = false;
        open.consecutiveFailures += 1;
        open.state = open.consecutiveFailures >= OFFLINE_STREAK ? 'unavailable' : open.state;
      }
      open.inFlight = false;
    }
    this.emitPending();
    const live = open.activity !== null && isLiveBridgeTurn(open.activity);
    this.scheduleActivityPoll(live ? ACTIVITY_LIVE_MS : ACTIVITY_IDLE_MS);
  }

  private recordFailure(runtime: BridgeRuntime, error: unknown): void {
    const code = bridgeErrorCode(error);
    runtime.lastErrorCode = code;
    if (code === 'rate_limited') {
      // PLAN §6: 429 rate_limited -> double interval to a 30 s ceiling.
      runtime.rateLimited = true;
      runtime.listBackoffUntil = this.now() + jitter(
        Math.min(LIST_POLL_MS * 2, RATE_LIMIT_CAP_MS),
      );
      return;
    }
    if (code === 'busy') {
      runtime.listBackoffUntil = this.now() + BUSY_RETRY_MS;
      return;
    }
    runtime.consecutiveFailures += 1;
    if (runtime.consecutiveFailures >= OFFLINE_STREAK) {
      // A single 503 never banners — the ACP child respawn window after a
      // turn ends produces a brief run of them (PLAN §6).
      runtime.state = 'unavailable';
    }
  }

  private currentPending(): PendingInteraction[] {
    const pending: PendingInteraction[] = [];
    for (const [bridgeId, runtime] of this.bridges) {
      if (runtime.page) {
        pending.push(...pendingInteractionsForPage(bridgeId, runtime.page));
      }
    }
    const open = this.openSession;
    const awaiting = open?.activity?.awaiting;
    if (open && awaiting) {
      const key = `${open.bridgeId}:${open.sessionId}:${awaiting}`;
      if (!pending.some((entry) => entry.key === key)) {
        pending.push({
          key,
          bridgeId: open.bridgeId,
          sessionId: open.sessionId,
          kind: awaiting,
        });
      }
    }
    return pending;
  }

  private emitPending(): void {
    try {
      this.onPending(this.currentPending());
    } catch {
      // A notification sink must not kill the poll loop.
    }
  }
}
