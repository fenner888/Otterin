// Local lint config for mac-client — the repo root .eslintrc.js ignores
// this dir (Electron globals would fail the RN ruleset). Keep it lean:
// parser + recommended rules only, --max-warnings 0 compatible.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'release/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
  },
  overrides: [
    {
      files: ['src/renderer/**/*.{ts,tsx}'],
      env: { browser: true, node: false },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    {
      // Scripts are plain ESM run by electron-builder hooks / node.
      files: ['scripts/**/*.mjs'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    },
  ],
};
