import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/redis'],
  testMatch: ['**/*.redis.test.ts'],
  testTimeout: 20_000,
};

export default config;
