/**
 * Jest config. Uses babel-jest (Expo default) + jest-environment-node for
 * pure-logic tests. Component tests (added in later sessions) use
 * @testing-library/react-native.
 */

module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  moduleNameMapper: {
    '^@theme/(.*)$': '<rootDir>/src/theme/$1',
    '^@api/(.*)$': '<rootDir>/src/api/$1',
    '^@auth/(.*)$': '<rootDir>/src/auth/$1',
    '^@lib/(.*)$': '<rootDir>/src/lib/$1',
    '^@store/(.*)$': '<rootDir>/src/store/$1',
    '^@components/(.*)$': '<rootDir>/src/components/$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|nativewind|@tanstack|zustand|zod|react-native-markdown-display)',
  ],
  setupFiles: ['<rootDir>/tests/setup.ts'],
};
