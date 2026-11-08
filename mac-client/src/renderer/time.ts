/**
 * Time formatting — ports of src/lib/messageTime.ts and
 * src/lib/session-utils.ts `relativeTime` for the desktop renderer.
 */

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Relative age of a ms-epoch timestamp: "just now", "2m ago", "3h ago"… */
export function relativeTimeMs(ms: number, now = Date.now()): string {
  const diff = (now - ms) / 1_000;
  if (diff < 60) return 'just now';
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`;
  if (diff < 604_800) return `${Math.floor(diff / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatDayLabel(ms: number, now: number): string {
  const date = new Date(ms);
  const current = new Date(now);
  if (localDayKey(ms) === localDayKey(now)) return 'Today';

  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDayKey(ms) === localDayKey(yesterday.getTime())) return 'Yesterday';

  const month = MONTH_ABBREVIATIONS[date.getMonth()] ?? '';
  return date.getFullYear() === current.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  const hour = date.getHours();
  const displayHour = hour % 12 || 12;
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${displayHour}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatFullDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAY_NAMES[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${formatClockTime(ms)}`;
}

export interface MessageTimeLabel {
  daySeparator?: string;
  time?: string;
}

/**
 * One label per message: a day separator on the first message of each local
 * day, and a clock time on the last message of each same-source run.
 */
export function messageTimeLabels(
  messages: Array<{ source: string; createdAt?: number }>,
  now: number,
): MessageTimeLabel[] {
  const labels = messages.map(() => ({} as MessageTimeLabel));
  let previousTimestampedDay: string | undefined;

  messages.forEach((message, index) => {
    if (message.createdAt === undefined) return;
    const label = labels[index];
    if (!label) return;

    const day = localDayKey(message.createdAt);
    if (day !== previousTimestampedDay) {
      label.daySeparator = formatDayLabel(message.createdAt, now);
    }
    previousTimestampedDay = day;

    if (messages[index + 1]?.source !== message.source) {
      label.time = formatClockTime(message.createdAt);
    }
  });

  return labels;
}

/** "4:32" countdown for permission expiry — clamps at 0:00. */
export function countdownLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const minutes = Math.floor(remaining / 60);
  const seconds = `${remaining % 60}`.padStart(2, '0');
  return `${minutes}:${seconds}`;
}
