// Local lint config for mac-client — the repo root .eslintrc.js ignores
// this dir (Electron globals would fail the RN ruleset). Plugin/parser
// packages resolve from the workspace-root node_modules.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'release/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
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
