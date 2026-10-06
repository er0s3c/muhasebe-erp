import { defineConfig, devices } from '@playwright/test';

// Dedicated local ports and the existing disposable test database; never reuses a customer's server.
export default defineConfig({
  testDir: 'e2e',
  testMatch: ['workspace-flow.spec.ts', 'construction-flow.spec.ts', 'administration-flow.spec.ts'],
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/workspace',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5187',
    locale: 'tr-TR',
    actionTimeout: 15_000,
    timezoneId: 'Europe/Istanbul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start -w @erp/api',
      url: 'http://127.0.0.1:3187/api/health/ready',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL:
          process.env.TEST_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_test',
        JWT_SECRET: 'workspace-e2e-secret-01234567890123456789',
        PORT: '3187',
        HOST: '127.0.0.1',
        RATE_LIMIT_ENABLED: 'false',
        COOKIE_SECURE: 'false',
        REGISTRATION_ENABLED: 'true',
        LICENSE_ENFORCEMENT_DEV: 'false',
        LOG_LEVEL: 'warn',
        WEB_DIST_DIR: '',
      },
    },
    {
      command: `npm run ${process.env.E2E_CONSTRUCTION_PRODUCTION === '1' ? 'preview' : 'dev'} -w @erp/web -- --host 127.0.0.1 --port 5187 --strictPort`,
      url: 'http://127.0.0.1:5187',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_TARGET: 'http://127.0.0.1:3187' },
    },
  ],
});
