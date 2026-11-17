export function stripUnsafeText(input: string, replacement = ''): string {
  return input.replace(/[\p{Cc}\p{Cf}\u034f\u200b-\u200f\u2028-\u202f\u2060-\u206f]/gu, replacement);
}

export function safeDisplayText(input: string, maximumLength = 80): string {
  const collapsed = stripUnsafeText(input, ' ').replace(/\s+/g, ' ').trim();
  return [...collapsed].slice(0, maximumLength).join('') || 'Unnamed iPhone';
}
