import { defineConfig, devices } from '@playwright/test';

/**
 * Uçtan uca testler gerçek API + gerçek PostgreSQL + Vite geliştirme sunucusu ile çalışır.
 * Önce `npm run db:migrate` çalıştırılmış olmalıdır. Ortamda hazır bir Chromium varsa
 * PW_CHROMIUM_PATH ile gösterilebilir (indirme yapılmaz).
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // CI çalıştırıcıları yerel makineden yavaştır; en uzun senaryo (kasa/banka) orada 60 sn'yi aşıyordu.
  timeout: process.env.CI ? 150_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'tr-TR',
    timezoneId: 'Europe/Nicosia',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start -w @erp/api',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
      env: { RATE_LIMIT_ENABLED: 'false' },
    },
    {
      command: 'npm run dev -w @erp/web',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
