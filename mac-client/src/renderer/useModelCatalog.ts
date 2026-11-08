/**
 * Lazy `session:create_options` loader shared by the composer model picker
 * and the new-session flow. Fetches on first `open()`; `refresh()` issues
 * `refresh: true` to pull a live catalog (create_options has its own 10/min
 * bucket, so a user-driven refresh is cheap).
 */
import { useCallback, useRef, useState } from 'react';

import { useApp } from './store';
import type { CreateOptions } from './types';

export interface ModelCatalog {
  options: CreateOptions | undefined;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  refreshError: boolean;
  open(): void;
  refresh(): void;
  ensure(): Promise<CreateOptions | undefined>;
}

export function useModelCatalog(bridgeId: string): ModelCatalog {
  const { bridge } = useApp();
  const [options, setOptions] = useState<CreateOptions | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const requested = useRef(false);

  const load = useCallback(
    async (refresh: boolean) => {
      try {
        const data = await bridge.createOptions(bridgeId, refresh);
        setOptions(data);
        setError(false);
        return data;
      } catch {
        if (refresh) setRefreshError(true);
        else setError(true);
        return undefined;
      }
    },
    [bridge, bridgeId],
  );

  const open = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setLoading(true);
    void load(false).finally(() => setLoading(false));
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRefreshError(false);
    void load(true).finally(() => setRefreshing(false));
  }, [load]);

  const ensure = useCallback(async (): Promise<CreateOptions | undefined> => {
    if (options) return options;
    requested.current = true;
    setLoading(true);
    const data = await load(false);
    setLoading(false);
    return data;
  }, [load, options]);

  return { options, loading, error, refreshing, refreshError, open, refresh, ensure };
}
