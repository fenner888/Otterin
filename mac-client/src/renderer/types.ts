/**
 * Renderer-side protocol types + the IPC contract with the main process.
 *
 * Shapes mirror PLAN.md §3.4 / §4 and the validated client schemas in
 * `src/auth/computerBridge.ts` (iOS). Field names are exact; optional markers
 * match the wire.
 *
 * ── IPC contract (main must implement) ──────────────────────────────────────
 *
 * Every preload channel returns an `IpcResult<T>` envelope — NEVER throws —
 * because Electron's ipcRenderer error propagation drops custom fields:
 *
 *   { ok: true,  result: T }
 *   { ok: false, error: { code: BridgeErrorCode, message: string } }
 *
 * Payloads always carry `bridgeId` (the PairedComputerSummary the request
 * targets). Channel → payload/result:
 *
 *   computers:list            ()                                   → PairedComputerSummary[]
 *   computers:disconnect      { bridgeId }                         → { disconnected: true }
 *   bridge:health             { bridgeId }                         → BridgeHealth
 *   bridge:features           { bridgeId, presentation?: true }    → BridgeFeatures & BridgePresentationCarrier
 *   bridge:version            { bridgeId }                         → { version: string }
 *   session:list              { bridgeId, cursor?, interaction?: true, ownership?: true }
 *                                                                  → SessionListPage
 *   session:load              { bridgeId, sessionId, interaction?: true, timestamps?: true }
 *                                                                  → LoadedSession
 *   session:activity          { bridgeId, sessionId, interaction?: true }
 *                                                                  → SessionActivity
 *   session:prompt            { bridgeId, sessionId, text, modelId?, autoApprove? }
 *                                                                  → { accepted: true, sessionId? }
 *   session:cancel            { bridgeId, sessionId }              → { cancelled: true }
 *   session:elicitation       { bridgeId, sessionId }              → { interaction: ElicitationInteraction | null }
 *   session:elicitation:respond { bridgeId, sessionId, interactionId, action:'accept', content }
 *                                  | { bridgeId, sessionId, interactionId, action:'decline'|'cancel' }
 *                                                                  → { accepted: true }
 *   session:permission        { bridgeId, sessionId }              → { permission: SessionPermission | null }
 *   session:permission:respond{ bridgeId, sessionId, permissionId, decision }
 *                                                                  → { accepted: true }
 *   session:createOptions     { bridgeId, refresh?: boolean }      → CreateOptions
 *   session:create            { bridgeId, workspaceId, modelId?, text, autoApprove? }
 *                                                                  → { accepted: true, sessionId }
 *   device:revoke             { bridgeId }                         → { revoked: true }
 *
 * Pairing ceremony (the offer NEVER crosses IPC — spec-021 one-shot rule;
 * main keeps the decoded offer in memory between capture and submit):
 *
 *   pair:capture              ()  → PairCapture
 *     { status:'captured', computerName?, bridgeKeyFingerprint,
 *       deviceKeyFingerprint, expiresAt }        — offer held in main
 *     { status:'failed', reason: 'no_qr' | 'capture_denied' | 'invalid' |
 *                                'version_incompatible' }
 *   pair:submit               { deviceName }     → PairSubmit
 *     Runs submit + approval poll + receipt persist in main (single
 *     long-lived invoke, ≤ ~300 s): { status:'approved', computerName? } |
 *     { status:'denied' } | { status:'expired' } — offer TTL or approval
 *     window lapsed; renderer returns to the capture step.
 *
 * App-level affordances (fixed-argv `open -a` on the main side):
 *
 *   app:openConnector         ()  — `open -a "Otterin Connector"` so its QR
 *                                   pairing window is visible for capture.
 *   app:openDevin             ()  — `open -a Devin` (app-level only; no
 *                                   per-session deep link exists).
 *
 * Error codes in `error.code` come from the bridge failure map (PLAN §3.2):
 * 404 → 'authorization_failed' | 'not_paired' | 'permission_denied',
 * 409 → 'conflict' | 'auto_approve_unavailable' | 'busy',
 * 429 → 'busy' | 'rate_limited', 503 → 'unavailable',
 * 400 → 'invalid_request' | 'unsupported_method' | 'invalid_response' |
 *       'too_many_sessions'.
 * The renderer's `ownership: true` flag is opt-in (patch 6); main handles the
 * older-Connector 400 fallback internally.
 */

// ── Shared primitives ────────────────────────────────────────────────────────

export type IpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

export type BridgeErrorCode =
  | 'not_paired'
  | 'permission_denied'
  | 'authorization_failed'
  | 'busy'
  | 'conflict'
  | 'auto_approve_unavailable'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported_method'
  | 'invalid_request'
  | 'invalid_response'
  | 'too_many_sessions';

export type OtterinChannel =
  | 'pair:capture'
  | 'pair:submit'
  | 'computers:list'
  | 'computers:disconnect'
  | 'bridge:health'
  | 'bridge:features'
  | 'bridge:version'
  | 'session:list'
  | 'session:load'
  | 'session:activity'
  | 'session:prompt'
  | 'session:cancel'
  | 'session:elicitation'
  | 'session:elicitation:respond'
  | 'session:permission'
  | 'session:permission:respond'
  | 'session:createOptions'
  | 'session:create'
  | 'device:revoke'
  | 'app:openConnector'
  | 'app:openDevin';

export interface OtterinBridge {
  invoke(channel: OtterinChannel, payload?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    otterin?: OtterinBridge;
  }
}

// ── Paired computers ─────────────────────────────────────────────────────────

export type BridgePermission =
  | 'bridge:health'
  | 'session:metadata:read'
  | 'session:content:read'
  | 'session:prompt:send'
  | 'session:create';

export type ComputerTransportKind = 'local_network' | 'tailscale_vpn';

/** Only fields safe to expose over IPC — no endpoint, key ids, fingerprints. */
export interface PairedComputerSummary {
  bridgeId: string;
  computerName: string;
  pairedAt: number;
  permissions: BridgePermission[];
  transportKind: ComputerTransportKind;
}

// ── bridge.health / features / version ───────────────────────────────────────

export interface BridgeHealth {
  protocolVersion: 2;
  status: 'ready';
  capabilities: {
    sessionList: boolean;
    sessionLoad: boolean;
    sessionPrompt: boolean;
  };
}

export interface BridgeFeatures {
  sessionElicitation: boolean;
  activityTimeline?: boolean;
  permissionPrompts?: boolean;
  sessionCancel?: boolean;
  autoApprove?: boolean;
}

export interface ComputerGrants {
  viewSessions: boolean;
  sendPrompts: boolean;
  startSessions: boolean;
}

export interface BridgePresentation {
  messageTimestamps: boolean;
  grants: ComputerGrants;
}

/** bridge:features result — feature flags plus presentation when requested. */
export interface BridgeFeaturesResult extends BridgeFeatures {
  presentation?: BridgePresentation;
}

export interface BridgeVersion {
  version: string;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export type ActivityKind =
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'executing'
  | 'searching'
  | 'fetching'
  | 'responding';

export type AwaitingKind = 'answer' | 'approval';

/** Patch-6 opt-in ownership attribution (absent on older Connectors). */
export type SessionOwner = 'free' | 'locked_external' | 'connector_live';

export interface SessionListActivity {
  active: boolean;
  kind?: ActivityKind;
  /** ms epoch int on the wire. */
  updatedAt: number;
  awaiting?: AwaitingKind;
}

export interface SessionListRow {
  id: string;
  origin: 'computer';
  workspaceName: string;
  hasTitle: boolean;
  title?: string;
  /** ISO string on list rows (normalized by callers to ms for math). */
  updatedAt?: string;
  model?: ComputerModel;
  activity?: SessionListActivity;
  owner?: SessionOwner;
  ownerName?: string;
}

export interface SessionListPage {
  sessions: SessionListRow[];
  nextCursor?: string;
}

export interface SessionMessage {
  sequence: number;
  source: 'user' | 'devin';
  text: string;
  /** ms epoch when `timestamps:true` was requested and supported. */
  createdAt?: number;
}

export type ActivityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown'
  | 'awaiting_input'
  | 'timed_out';

export type ActivityToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export type ActivityDetail =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText?: string; newText?: string };

export interface ActivityEntry {
  id: string;
  afterSequence: number;
  kind: 'thought' | 'tool';
  toolKind?: ActivityToolKind;
  status: ActivityStatus;
  title: string;
  /** workspace-relative paths */
  paths?: string[];
  detail?: ActivityDetail;
  truncated: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface SessionSummaryEmbedded {
  id: string;
  origin: 'computer';
  workspaceName: string;
  model?: ComputerModel;
  owner?: SessionOwner;
  ownerName?: string;
}

export interface LoadedSession {
  session: SessionSummaryEmbedded;
  messages: SessionMessage[];
  activity?: ActivityEntry[];
  truncated: boolean;
}

export interface TurnSnapshot {
  startedAt: number;
  reply: string;
  activity: ActivityEntry[];
}

export interface TerminalQuestion {
  question: string;
  header?: string;
  options: string[];
  multiSelect: boolean;
}

export interface SessionActivity {
  active: boolean;
  kind: ActivityKind;
  /** bridge vocabulary label ("Response ready", "Waiting for your approval"…) */
  label: string;
  updatedAt: number;
  awaiting?: AwaitingKind;
  terminalQuestion?: { questions: TerminalQuestion[] };
  /** Only for bridge-owned turns; persists after the turn ends. */
  turn?: TurnSnapshot;
}

// ── Interactions ─────────────────────────────────────────────────────────────

export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationFieldOption {
  value: string;
  label: string;
}

export interface ElicitationField {
  key: string;
  type: 'text' | 'single_select' | 'multi_select' | 'number' | 'integer' | 'boolean';
  title: string;
  description?: string;
  required: boolean;
  options?: ElicitationFieldOption[];
  allowOther?: true;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  defaultValue?: ElicitationValue;
}

export interface ElicitationInteraction {
  id: string;
  message: string;
  title?: string;
  description?: string;
  fields: ElicitationField[];
  createdAt: number;
}

export type ElicitationAnswer =
  | { interactionId: string; action: 'accept'; content: Record<string, ElicitationValue> }
  | { interactionId: string; action: 'decline' | 'cancel' };

export type PermissionDecision = 'allow_once' | 'allow_session' | 'reject_once';

export interface SessionPermission {
  id: string;
  title: string;
  toolKind?: ActivityToolKind;
  command?: string;
  paths?: string[];
  decisions: PermissionDecision[];
  createdAt: number;
  /** ms epoch — auto-cancel fires here (10 min). */
  expiresAt: number;
}

// ── Create options ───────────────────────────────────────────────────────────

export interface ComputerModel {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
  badge?: 'new' | 'free_promo';
  costTier?: 'low' | 'medium' | 'high' | 'free';
  costSummary?: string;
  recent?: boolean;
  recommended?: boolean;
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface CreateOptions {
  workspaces: WorkspaceOption[];
  models: ComputerModel[];
  defaultModelId: string | null;
  catalogSource: 'live' | 'recent';
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export type PairCapture =
  | {
      status: 'captured';
      computerName?: string;
      bridgeKeyFingerprint: string;
      /** This device's truncated SAS fingerprint — show for comparison. */
      deviceKeyFingerprint: string;
      expiresAt: number;
    }
  | {
      status: 'failed';
      reason: 'no_qr' | 'capture_denied' | 'invalid' | 'version_incompatible';
    };

export type PairSubmit =
  | { status: 'approved'; computerName?: string }
  | { status: 'denied' }
  | { status: 'expired' };

// ── Renderer-side board aggregates ───────────────────────────────────────────

export type DiscoveryState =
  | 'ready'
  | 'session_discovery_off'
  | 'authorization_failed'
  | 'unavailable'
  | 'invalid_response'
  | 'too_many_sessions'
  | 'busy';

export interface ComputerDiscoveryStatus {
  bridgeId: string;
  computerName: string;
  state: DiscoveryState;
}

/** A session row joined with its owning computer for the unified board. */
export interface BoardSession extends SessionListRow {
  bridgeId: string;
  computerName: string;
}

export type PollingMode = 'battery_saver' | 'balanced' | 'fast';
