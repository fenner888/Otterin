// Structural bridge connection contract for the Mac client (PLAN §3.4).
//
// client-core's computerBridge.ts exports `ComputerBridgeConnection` with
// these same method names; this interface is deliberately widened to
// Promise<unknown> so the real implementation is structurally assignable
// when the client-core copy lands (client-core-wiring.ts adapts it and adds
// getPlatform/revokeDevice, which upstream exposes as free functions).
//
// Everything the main process itself consumes (scheduler liveness, pending
// approval counts, notification triggers) is extracted through the small
// zod summary schemas below — full response validation stays in
// client-core and the renderer.

import { z } from 'zod';

export interface BridgeConnection {
  bridgeId: string;
  getHealth(): Promise<unknown>;
  getFeatures(): Promise<unknown>;
  getVersion(): Promise<unknown>;
  getPlatform(): Promise<unknown>;
  listSessions(input?: { cursor?: string }): Promise<unknown>;
  loadSession(sessionId: string, options?: { timestamps?: boolean }): Promise<unknown>;
  getSessionActivity(sessionId: string): Promise<unknown>;
  getSessionElicitation(sessionId: string): Promise<unknown>;
  respondToSessionElicitation(input: unknown): Promise<unknown>;
  getSessionPermission(sessionId: string): Promise<unknown>;
  respondToSessionPermission(input: unknown): Promise<unknown>;
  cancelSession(sessionId: string): Promise<unknown>;
  promptSession(
    sessionId: string,
    text: string,
    modelId?: string,
    autoApprove?: boolean,
  ): Promise<unknown>;
  getCreateOptions(refresh?: boolean): Promise<unknown>;
  createSession(input: {
    workspaceId: string;
    modelId?: string | null;
    text: string;
    autoApprove?: boolean;
  }): Promise<unknown>;
  /** device.revoke against this bridge (revokes the calling device only). */
  revokeDevice(): Promise<unknown>;
}

export type ResolveBridgeConnection = (bridgeId: string) => Promise<BridgeConnection>;

export const awaitingKindSchema = z.enum(['answer', 'approval']);
export type AwaitingKind = z.infer<typeof awaitingKindSchema>;

// Fields the main process reads out of a session.activity response or a
// session.list row's `activity` object. `turn` presence + `active` is the
// bridge-owned-live-turn signal (PLAN §4).
export const activitySummarySchema = z
  .object({
    active: z.boolean(),
    awaiting: awaitingKindSchema.optional(),
    turn: z.unknown().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

export const sessionListRowSchema = z
  .object({
    id: z.string().min(1),
    activity: activitySummarySchema.optional(),
  })
  .passthrough();

export const sessionPageSnapshotSchema = z
  .object({
    sessions: z.array(sessionListRowSchema),
    nextCursor: z.string().optional(),
  })
  .passthrough();
export type SessionPageSnapshot = z.infer<typeof sessionPageSnapshotSchema>;

/** A pending interaction one of the paired sessions is waiting on. */
export interface PendingInteraction {
  key: string;
  bridgeId: string;
  sessionId: string;
  kind: AwaitingKind;
}

export function pendingInteractionsForPage(
  bridgeId: string,
  page: SessionPageSnapshot,
): PendingInteraction[] {
  const pending: PendingInteraction[] = [];
  for (const session of page.sessions) {
    const awaiting = session.activity?.awaiting;
    if (awaiting) {
      pending.push({
        key: `${bridgeId}:${session.id}:${awaiting}`,
        bridgeId,
        sessionId: session.id,
        kind: awaiting,
      });
    }
  }
  return pending;
}

/** True when an activity response describes a live bridge-owned turn. */
export function isLiveBridgeTurn(summary: ActivitySummary): boolean {
  return summary.active && summary.turn !== undefined;
}

/**
 * Duck-typed error-code reader. client-core throws ComputerBridgeError with
 * a `code` field; importing the class here would couple this file to a
 * module that lands in a different slice.
 */
export function bridgeErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return null;
}
