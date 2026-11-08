import type { Config } from 'tailwindcss';
// Palette mirrors src/theme/tokens.ts (dark). Raw hex lives only in the
// tokens source — this maps token names to their resolved values.
import { dark, radii, spacing } from '../src/theme/tokens';

const colors = Object.fromEntries(
  Object.entries(dark).map(([name, token]) => [name, token.hex]),
);

export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors,
      borderRadius: radii,
      spacing,
    },
  },
  plugins: [],
} satisfies Config;
