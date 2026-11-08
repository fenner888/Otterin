// Pending-approval notifications + Dock badge (PLAN §7, §8).
//
// Notification bodies stay generic — never session content, command text,
// or question text. The Dock badge is the numeric count of pending
// interactions; the tray icon-state swap is a later slice.

import type { PendingInteraction } from './bridge-client';

function electronApi(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

const GENERIC_TITLE = 'Otterin';
const GENERIC_BODY = 'A session is waiting for your approval or answer';

// Keys of pending interactions we have already notified about — first
// responder wins, so a key that disappears (answered on another device)
// is dropped and can notify again if it ever reappears.
let notifiedKeys = new Set<string>();

export function updateDockBadge(pendingCount: number): void {
  try {
    const { app } = electronApi();
    app.dock?.setBadge(pendingCount > 0 ? String(pendingCount) : '');
  } catch {
    // Badge is best-effort — never let chrome failure kill the poll loop.
  }
}

function postGenericNotification(): void {
  try {
    const { Notification } = electronApi();
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({ title: GENERIC_TITLE, body: GENERIC_BODY });
    notification.show();
  } catch {
    // Best-effort — see above.
  }
}

/**
 * Reconcile the pending set: post one generic notification per newly
 * pending interaction, refresh the Dock badge, and retire keys that are no
 * longer pending (answered on any device).
 */
export function notifyPendingInteractions(pending: PendingInteraction[]): void {
  const currentKeys = new Set(pending.map((entry) => entry.key));
  const fresh = pending.filter((entry) => !notifiedKeys.has(entry.key));
  notifiedKeys = currentKeys;
  if (fresh.length > 0) {
    postGenericNotification();
  }
  updateDockBadge(currentKeys.size);
}

/** Test/dev reset hook. */
export function resetNotificationState(): void {
  notifiedKeys = new Set<string>();
}
