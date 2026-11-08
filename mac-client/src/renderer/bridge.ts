/**
 * Typed client over `window.otterin.invoke`. Every channel returns the
 * `IpcResult` envelope documented in types.ts; this module unwraps it and
 * throws `OtterinBridgeError` on `{ ok:false }` so call sites stay simple.
 *
 * In dev (`vite dev`), when no preload bridge exists or `?mock=1` is set,
 * the stateful fixture mock in bridge-mock.ts is used instead so the full UI
 * runs without a Connector.
 */
import { OtterinBridgeError } from './errors';
import type {
  BridgeFeaturesResult,
  BridgeHealth,
  BridgeVersion,
  CreateOptions,
  ElicitationAnswer,
  ElicitationInteraction,
  LoadedSession,
  OtterinBridge,
  OtterinChannel,
  PairCapture,
  PairSubmit,
  PairedComputerSummary,
  PermissionDecision,
  SessionActivity,
  SessionListPage,
  SessionPermission,
} from './types';

function unwrap<T>(channel: string, raw: unknown): T {
  const envelope = raw as
    | { ok: true; result: T }
    | { ok: false; error: { code?: string; message?: string } }
    | undefined;
  if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
    if (envelope.ok === true) return envelope.result;
    if (envelope.ok === false) {
      throw new OtterinBridgeError(
        envelope.error?.code ?? 'unavailable',
        envelope.error?.message,
      );
    }
  }
  // Tolerate a main side that resolves with the bare result (dev safety);
  // the envelope is still the contract.
  if (raw !== undefined && raw !== null && typeof raw === 'object' && !('ok' in raw)) {
    return raw as T;
  }
  throw new OtterinBridgeError(
    'invalid_response',
    `Malformed IPC result on ${channel}`,
  );
}

export interface Bridge {
  listComputers(): Promise<PairedComputerSummary[]>;
  disconnectComputer(bridgeId: string): Promise<{ disconnected: true }>;
  health(bridgeId: string): Promise<BridgeHealth>;
  features(bridgeId: string, presentation?: boolean): Promise<BridgeFeaturesResult>;
  version(bridgeId: string): Promise<BridgeVersion>;
  listSessions(
    bridgeId: string,
    input?: { cursor?: string },
  ): Promise<SessionListPage>;
  loadSession(
    bridgeId: string,
    sessionId: string,
    input?: { timestamps?: boolean },
  ): Promise<LoadedSession>;
  sessionActivity(bridgeId: string, sessionId: string): Promise<SessionActivity>;
  promptSession(
    bridgeId: string,
    sessionId: string,
    input: { text: string; modelId?: string; autoApprove?: boolean },
  ): Promise<{ accepted: true; sessionId?: string }>;
  cancelSession(bridgeId: string, sessionId: string): Promise<{ cancelled: true }>;
  sessionElicitation(
    bridgeId: string,
    sessionId: string,
  ): Promise<{ interaction: ElicitationInteraction | null }>;
  respondElicitation(
    bridgeId: string,
    sessionId: string,
    answer: ElicitationAnswer,
  ): Promise<{ accepted: true }>;
  sessionPermission(
    bridgeId: string,
    sessionId: string,
  ): Promise<{ permission: SessionPermission | null }>;
  respondPermission(
    bridgeId: string,
    sessionId: string,
    input: { permissionId: string; decision: PermissionDecision },
  ): Promise<{ accepted: true }>;
  createOptions(bridgeId: string, refresh?: boolean): Promise<CreateOptions>;
  createSession(
    bridgeId: string,
    input: { workspaceId: string; modelId?: string | null; text: string; autoApprove?: boolean },
  ): Promise<{ accepted: true; sessionId: string }>;
  revokeDevice(bridgeId: string): Promise<{ revoked: true }>;
  pairCapture(): Promise<PairCapture>;
  pairSubmit(deviceName: string): Promise<PairSubmit>;
  /** main-wired affordances (documented channels; may reject until wired). */
  openConnector(): Promise<unknown>;
  openDevin(): Promise<unknown>;
}

export function createBridge(transport: OtterinBridge): Bridge {
  async function call<T>(channel: OtterinChannel, payload?: unknown): Promise<T> {
    const raw = await transport.invoke(channel, payload);
    return unwrap<T>(channel, raw);
  }
  return {
    listComputers: () => call('computers:list'),
    disconnectComputer: (bridgeId) => call('computers:disconnect', { bridgeId }),
    health: (bridgeId) => call('bridge:health', { bridgeId }),
    features: (bridgeId, presentation) =>
      call('bridge:features', { bridgeId, ...(presentation ? { presentation: true } : {}) }),
    version: (bridgeId) => call('bridge:version', { bridgeId }),
    listSessions: (bridgeId, input = {}) =>
      call('session:list', {
        bridgeId,
        interaction: true,
        ownership: true,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    loadSession: (bridgeId, sessionId, input = {}) =>
      call('session:load', {
        bridgeId,
        sessionId,
        interaction: true,
        ...(input.timestamps ? { timestamps: true } : {}),
      }),
    sessionActivity: (bridgeId, sessionId) =>
      call('session:activity', { bridgeId, sessionId, interaction: true }),
    promptSession: (bridgeId, sessionId, input) =>
      call('session:prompt', { bridgeId, sessionId, ...input }),
    cancelSession: (bridgeId, sessionId) => call('session:cancel', { bridgeId, sessionId }),
    sessionElicitation: (bridgeId, sessionId) =>
      call('session:elicitation', { bridgeId, sessionId }),
    respondElicitation: (bridgeId, sessionId, answer) =>
      call('session:elicitation:respond', { bridgeId, sessionId, ...answer }),
    sessionPermission: (bridgeId, sessionId) =>
      call('session:permission', { bridgeId, sessionId }),
    respondPermission: (bridgeId, sessionId, input) =>
      call('session:permission:respond', { bridgeId, sessionId, ...input }),
    createOptions: (bridgeId, refresh) =>
      call('session:createOptions', { bridgeId, ...(refresh ? { refresh: true } : {}) }),
    createSession: (bridgeId, input) => call('session:create', { bridgeId, ...input }),
    revokeDevice: (bridgeId) => call('device:revoke', { bridgeId }),
    pairCapture: () => call('pair:capture'),
    pairSubmit: (deviceName) => call('pair:submit', { deviceName }),
    openConnector: () => call('app:openConnector'),
    openDevin: () => call('app:openDevin'),
  };
}

let cachedBridge: Bridge | null = null;

/**
 * Resolve the bridge the app will use. Mock selection: dev + `?mock=1`
 * forces the fixture bridge, `?mock=fresh` starts it unpaired (onboarding),
 * and dev with no `window.otterin` (plain-browser `vite dev`) falls back to
 * it so the app always renders. Production never mocks: a missing preload is
 * a fatal `unavailable` error surfaced by the caller.
 */
export async function initBridge(): Promise<Bridge> {
  if (cachedBridge) return cachedBridge;
  const params = new URLSearchParams(window.location.search);
  const mockFlag = params.get('mock');
  const wantsMock = mockFlag === '1' || mockFlag === 'fresh';
  if ((wantsMock || !window.otterin) && import.meta.env.DEV) {
    const { createMockOtterin } = await import('./bridge-mock');
    cachedBridge = createBridge(createMockOtterin({ fresh: mockFlag === 'fresh' }));
    return cachedBridge;
  }
  if (!window.otterin) {
    throw new OtterinBridgeError(
      'unavailable',
      'The Otterin preload bridge is not available in this window.',
    );
  }
  cachedBridge = createBridge(window.otterin);
  return cachedBridge;
}
