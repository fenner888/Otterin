import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { deleteLegacyCloudCache } from '@lib/legacyCloudCache';

import { wipeLegacyCloudCredentials } from './keychain';
import {
  clearPairedComputers,
  loadPairedComputerSummaries,
  type PairedComputerSummary,
} from './pairedComputers';

interface ConnectionContextValue {
  isLoading: boolean;
  isConfigured: boolean;
  hasComputerConnection: boolean;
  computers: PairedComputerSummary[];
  connectionError: string | null;
  refreshComputers: () => Promise<void>;
  disconnectAll: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [computers, setComputers] = useState<PairedComputerSummary[]>([]);
  const [isComputerLoading, setIsComputerLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const refreshComputers = useCallback(async () => {
    setIsComputerLoading(true);
    try {
      const nextComputers = await loadPairedComputerSummaries();
      setComputers(nextComputers);
      setConnectionError(null);
    } catch {
      setComputers([]);
      setConnectionError('Paired local-device credentials could not be validated.');
    } finally {
      setIsComputerLoading(false);
    }
  }, []);

  useEffect(() => {
    wipeLegacyCloudCredentials().catch(() => {});
    deleteLegacyCloudCache().catch(() => {});
    refreshComputers().catch(() => {});
  }, [refreshComputers]);

  const disconnectAll = useCallback(async () => {
    const [computerResult, legacyCredentialsResult, legacyCacheResult] = await Promise.allSettled([
      clearPairedComputers(),
      wipeLegacyCloudCredentials(),
      deleteLegacyCloudCache(),
    ]);
    if (computerResult.status === 'fulfilled') setComputers([]);
    if (
      legacyCredentialsResult.status === 'fulfilled' &&
      legacyCacheResult.status === 'fulfilled' &&
      computerResult.status === 'fulfilled'
    ) {
      setConnectionError(null);
      return;
    }
    throw new Error('Secure connection wipe did not complete');
  }, []);

  const value = useMemo<ConnectionContextValue>(() => {
    const hasComputerConnection = computers.length > 0;
    return {
      isLoading: isComputerLoading,
      isConfigured: hasComputerConnection,
      hasComputerConnection,
      computers,
      connectionError,
      refreshComputers,
      disconnectAll,
    };
  }, [isComputerLoading, computers, connectionError, refreshComputers, disconnectAll]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnections(): ConnectionContextValue {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error('useConnections must be used within ConnectionProvider');
  return context;
}
