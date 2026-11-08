import { useEffect, useRef, useState } from 'react';

export type PollOutcome = 'ok' | 'busy' | 'rate_limited' | 'error';

/**
 * Adaptive poll loop implementing the PLAN §6 back-off rules:
 *  - 'busy'         → one retry after ~400 ms, then normal cadence
 *  - 'rate_limited' → interval doubles each consecutive hit, 30 s ceiling + jitter
 *  - any outcome    → visibility-gated (Chromium throttles hidden renderers
 *    anyway; the loop does not run while `document.hidden` and fires
 *    immediately when the window becomes visible again).
 */
export function usePoll(
  run: () => Promise<PollOutcome>,
  intervalMs: number,
  enabled: boolean,
): void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | null = null;
    let busyRetryUsed = false;
    let rateLimitedStreak = 0;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => void cycle(), delay);
    };

    const cycle = async () => {
      if (stopped || document.hidden) return;
      const outcome = await runRef.current();
      if (stopped) return;
      let delay = intervalMs;
      if (outcome === 'busy') {
        if (!busyRetryUsed) {
          busyRetryUsed = true;
          delay = 400;
        }
      } else {
        busyRetryUsed = false;
        if (outcome === 'rate_limited') {
          rateLimitedStreak = Math.min(rateLimitedStreak + 1, 5);
        } else {
          rateLimitedStreak = 0;
        }
      }
      if (rateLimitedStreak > 0) {
        delay = Math.min(intervalMs * 2 ** rateLimitedStreak, 30_000) + Math.random() * 750;
      }
      schedule(delay);
    };

    const onVisibility = () => {
      if (stopped || document.hidden) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void cycle();
    };

    document.addEventListener('visibilitychange', onVisibility);
    void cycle();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}

/** A ticking clock for countdowns and relative labels. */
export function useNow(intervalMs = 1_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
