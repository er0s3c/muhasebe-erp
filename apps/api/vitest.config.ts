import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DB fixtures and installation/schema checks must not overlap across files.
    // Explicit concurrency tests still run simultaneous commands inside their own file.
    maxWorkers: 1,
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_ENABLED: 'false',
      JWT_SECRET: 'test-secret-test-secret-test-secret-32',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_test',
    },
  },
});
