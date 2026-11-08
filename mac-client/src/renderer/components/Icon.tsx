import type { CSSProperties } from 'react';

export type IconName =
  | 'plus'
  | 'search'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'stop'
  | 'shield'
  | 'shield-check'
  | 'arrow-up'
  | 'close'
  | 'refresh'
  | 'gear'
  | 'external'
  | 'folder'
  | 'desktop'
  | 'clock'
  | 'check'
  | 'lock'
  | 'info'
  | 'branch'
  | 'alert'
  | 'sparkle'
  | 'dot'
  | 'terminal'
  | 'doc'
  | 'edit'
  | 'trash'
  | 'move'
  | 'globe'
  | 'jump-down';

const PATHS: Record<Exclude<IconName, 'dot' | 'stop'>, string[]> = {
  plus: ['M12 5v14M5 12h14'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  shield: [
    'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z',
  ],
  'shield-check': [
    'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z',
    'M9 11.5l2 2 4-4.5',
  ],
  'arrow-up': ['M12 19V5M5 12l7-7 7 7'],
  close: ['M18 6 6 18M6 6l12 12'],
  refresh: [
    'M21 12a9 9 0 1 1-2.64-6.36',
    'M21 3v6h-6',
  ],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  ],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z'],
  desktop: [
    'M2 4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z',
    'M8 21h8M12 17v4',
  ],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
  check: ['M20 6 9 17l-5-5'],
  lock: [
    'M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
    'M8 11V7a4 4 0 0 1 8 0v4',
  ],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4', 'M12 8h.01'],
  branch: [
    'M6 3v12',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M15 6a9 9 0 0 0-9 9',
  ],
  alert: [
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
    'M12 9v4',
    'M12 17h.01',
  ],
  sparkle: ['M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.4l-1.9-5.8L4.3 10.7l5.8-1.9L12 3Z'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  doc: [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z',
    'M14 2v6h6',
    'M8 13h8M8 17h8',
  ],
  edit: [
    'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z',
  ],
  trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'],
  move: ['M5 9l-3 3 3 3', 'M9 5l3-3 3 3', 'M15 19l-3 3-3-3', 'M19 9l3 3-3 3', 'M2 12h20', 'M12 2v20'],
  globe: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M2 12h20',
    'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z',
  ],
  'jump-down': ['M12 5v14', 'M5 12l7 7 7-7'],
};

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (name === 'dot') {
    return (
      <span
        className={className}
        style={{ width: size * 0.4, height: size * 0.4, borderRadius: 9999, display: 'inline-block', ...style }}
      />
    );
  }
  if (name === 'stop') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        style={style}
        aria-hidden
      >
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    );
  }
  const paths = PATHS[name] ?? PATHS.doc;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
