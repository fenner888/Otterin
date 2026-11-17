import VoiceNative, { type ScribeAvailability } from '../../../modules/devinx-voice/src';

export type ScribeKind = 'foundationModel' | 'template';

export interface ScribeResult {
  kind: ScribeKind;
  text: string;
}

export interface ScribeContext {
  destination?: string;
  repository?: string;
}

export interface ScribeEngine {
  availability(): Promise<ScribeAvailability>;
  structure(transcript: string, context: ScribeContext): Promise<ScribeResult>;
}

const FILLERS = /(^|[.!?]\s+)(?:um+|uh+|you know|I mean)\b(?:\s*,\s*|\s+)/gi;

export function cleanDictation(value: string): string {
  return value
    .replace(FILLERS, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function templateWorkOrder(transcript: string, context: ScribeContext = {}): string {
  const cleaned = cleanDictation(transcript);
  const scope = [context.destination, context.repository].filter(Boolean).join(' · ');
  return [
    'Goal',
    cleaned,
    '',
    'Scope / repo',
    scope || 'Not specified — confirm before starting.',
    '',
    'Acceptance criteria',
    '- Complete the requested outcome described under Goal.',
    '- Verify the result and report the validation performed.',
    '',
    'Constraints / non-goals',
    '- Preserve every constraint and non-goal stated in the dictated Goal.',
    '- Do not infer credentials, deadlines, repositories, or requirements that were not provided.',
  ].join('\n');
}

function contextText(context: ScribeContext): string {
  return [
    context.destination ? `Destination: ${context.destination}` : null,
    context.repository ? `Repository or workspace: ${context.repository}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function isValidStructuredWorkOrder(value: string): boolean {
  const headings = ['Goal', 'Scope / repo', 'Acceptance criteria', 'Constraints / non-goals'];
  let section = -1;
  let body: string[] = [];
  const validBody = () => body.length > 0 && (
    body.every((line) => /^-\s+\S/.test(line)) ||
    (body.length === 1 && !/^(?:#|[-*+]|\d+[.)])\s/.test(body[0]!) && !body[0]!.endsWith(':'))
  );
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingIndex = headings.indexOf(line);
    if (headingIndex !== -1) {
      if (headingIndex !== section + 1 || (section !== -1 && !validBody())) return false;
      section = headingIndex;
      body = [];
    } else {
      if (section === -1) return false;
      body.push(line);
    }
  }
  return section === headings.length - 1 && validBody();
}

export const onDeviceScribeEngine: ScribeEngine = {
  async availability() {
    if (!VoiceNative) return 'unsupportedOS';
    return VoiceNative.scribeAvailability();
  },

  async structure(transcript, context) {
    const fallback = templateWorkOrder(transcript, context);
    if (!VoiceNative || (await VoiceNative.scribeAvailability()) !== 'available') {
      return { kind: 'template', text: fallback };
    }
    try {
      const text = await VoiceNative.structureTranscript(cleanDictation(transcript), contextText(context));
      return isValidStructuredWorkOrder(text)
        ? { kind: 'foundationModel', text }
        : { kind: 'template', text: fallback };
    } catch {
      return { kind: 'template', text: fallback };
    }
  },
};
