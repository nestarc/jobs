import type { Config } from 'jest';
if (!process.env.REDIS_URL)
  throw new Error(
    'Redis-backed coverage requires REDIS_URL; start the disposable Redis fixture first.',
  );

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20_000,
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json-summary', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 95,
      lines: 90,
    },
    './src/backend/bullmq/': { statements: 95, branches: 80, functions: 95, lines: 95 },
    './src/backend/bullmq-backend.ts': {
      statements: 88,
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
};

export default config;
