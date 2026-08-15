import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20_000,
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    },
    './src/backend/bullmq-backend.ts': {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    },
  },
};

export default config;
