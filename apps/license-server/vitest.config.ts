import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Testler tek veritabanını paylaşır; dosyalar sırayla koşar.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_LICENSE_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_license_test',
    },
  },
});
