const STATIC_DEVELOPER_VOCABULARY = [
  'Devin',
  'Otterin',
  'TypeScript',
  'JavaScript',
  'React Native',
  'Expo Router',
  'TanStack Query',
  'Zod',
  'OAuth',
  'PostgreSQL',
  'RLS',
  'API',
  'PR',
  'GitHub Actions',
  'TestFlight',
  'EAS',
  'monorepo',
  'middleware',
  'endpoint',
  'refactor',
  'kebab-case',
  'Secure Store',
] as const;

export interface VoiceHintSources {
  repositories?: readonly string[];
  playbooks?: readonly string[];
  tags?: readonly string[];
}

const SECRET_SHAPED =
  /(?:bearer\s+|cog_|sk[-_]|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|private[-_]?key)/i;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{24,}$/;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const EMAIL_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function safeHint(value: string): string | null {
  const hint = value.trim().replace(/\s+/g, ' ');
  if (
    !hint ||
    hint.length > 64 ||
    SECRET_SHAPED.test(hint) ||
    OPAQUE_TOKEN.test(hint) ||
    JWT.test(hint) ||
    AWS_ACCESS_KEY_ID.test(hint) ||
    EMAIL_ADDRESS.test(hint)
  ) {
    return null;
  }
  return hint;
}

export function assembleVoiceHints(sources: VoiceHintSources = {}): string[] {
  const candidates = [
    ...STATIC_DEVELOPER_VOCABULARY,
    ...(sources.repositories ?? []).slice(0, 20),
    ...(sources.playbooks ?? []).slice(0, 10),
    ...(sources.tags ?? []).slice(0, 10),
  ];
  const output: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;
  for (const candidate of candidates) {
    const hint = safeHint(candidate);
    if (!hint) continue;
    const key = hint.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    if (totalLength + hint.length > 1_000 || output.length >= 64) break;
    seen.add(key);
    totalLength += hint.length;
    output.push(hint);
  }
  return output;
}
