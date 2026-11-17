import { safeDisplayText, stripUnsafeText } from '../../bridge/src/safe-text';

describe('safe display text', () => {
  const unsafe =
    '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u200B\u200C\u200D\u2060\uFEFF\u00AD\u034F';

  it('strips bidi and invisible characters without changing visible Unicode', () => {
    expect(stripUnsafeText(`echo ${unsafe}café 日本語`)).toBe('echo café 日本語');
    expect(stripUnsafeText('git status --short')).toBe('git status --short');
  });

  it('supports replacement and preserves display-name fallback and bounds', () => {
    expect(stripUnsafeText('first\u061Csecond', ' ')).toBe('first second');
    expect(safeDisplayText(`  First${unsafe} Second `)).toBe('First Second');
    expect(safeDisplayText(unsafe)).toBe('Unnamed iPhone');
    expect(safeDisplayText('café', 3)).toBe('caf');
    expect(stripUnsafeText('')).toBe('');
    expect(stripUnsafeText('\u0000\u001b\u007f\u0085')).toBe('');
  });
});
