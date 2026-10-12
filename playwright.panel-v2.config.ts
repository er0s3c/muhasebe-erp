import { defineConfig, devices } from '@playwright/test';

/** UI fixtures only: no database, license server, setup token or real customer data. */
export default defineConfig({
  testDir: 'lisans-server/e2e',
  testMatch: 'panel-v2.spec.ts',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/panel-v2',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5189',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : { channel: 'msedge' }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -w @erp/license-admin -- --host 127.0.0.1 --port 5189 --strictPort',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
