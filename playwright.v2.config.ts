import { defineConfig, devices } from '@playwright/test';

/** Workflows create their own accounts and companies in erp_test; demo data stays untouched. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['invoice-flow.spec.ts', 'treasury-flow.spec.ts', 'inventory-flow.spec.ts', 'pricing-serials-flow.spec.ts', 'matching-flow.spec.ts', 'payroll-flow.spec.ts', 'projects-flow.spec.ts', 'offline-drafts.spec.ts', 'mfa-flow.spec.ts', 'print-flow.spec.ts'],
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/v2-workflows',
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5176', locale: 'tr-TR', timezoneId: 'Europe/Istanbul', trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: 'msedge' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npx tsx .cache/v2-e2e-server.ts', url: 'http://127.0.0.1:3176/api/health', reuseExistingServer: false, timeout: 60_000,
      env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://erp_app:erp_app@localhost:5432/erp_test', JWT_SECRET: 'test-v2-secret-test-v2-secret-32-characters', RATE_LIMIT_ENABLED: 'false', CORS_ORIGIN: 'http://127.0.0.1:5176', COOKIE_SECURE: 'false', CONSTRUCTION_JOBS_ENABLED: 'false' } },
    { command: 'npm run dev -w @erp/web -- --host 127.0.0.1 --port 5176 --strictPort', url: 'http://127.0.0.1:5176', reuseExistingServer: false, timeout: 30_000, env: { VITE_API_TARGET: 'http://127.0.0.1:3176' } },
  ],
});
