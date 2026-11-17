const root = require('../../jest.config');
module.exports = {
  ...root,
  rootDir: '../..',
  testMatch: ['<rootDir>/evals/ai/**/*.eval.ts', '<rootDir>/evals/ai/**/*.eval.tsx'],
  setupFilesAfterEnv: ['<rootDir>/evals/ai/offline.ts'],
  reporters: ['default', '<rootDir>/evals/ai/reporter.cjs'],
};
