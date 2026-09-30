import { defineConfig, devices } from '@playwright/test';

/**
 * Uçtan uca testler gerçek API + gerçek PostgreSQL + Vite geliştirme sunucusu ile çalışır.
 * Önce `npm run db:migrate` çalıştırılmış olmalıdır. Ortamda hazır bir Chromium varsa
 * PW_CHROMIUM_PATH ile gösterilebilir (indirme yapılmaz).
 */
// E2E_TARGET=bundle: geliştirme sunucuları yerine ÜRETİM paketini sınar (`npm run build` sonrası
// `node apps/api/dist/server.js`; arayüzü API aynı kökenden sunar, CSP ve önbellek başlıkları dahil).
const bundle = process.env.E2E_TARGET === 'bundle';

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
    baseURL: bundle ? 'http://localhost:3000' : 'http://localhost:5173',
    locale: 'tr-TR',
    timezoneId: 'Europe/Nicosia',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: bundle
    ? [
        {
          command: 'node --env-file-if-exists=.env --enable-source-maps apps/api/dist/server.js',
          url: 'http://localhost:3000/api/health/ready',
          reuseExistingServer: false,
          timeout: 60_000,
          env: {
            NODE_ENV: 'production',
            JWT_SECRET: 'e2e-bundle-jwt-key-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
            RATE_LIMIT_ENABLED: 'false',
            WEB_DIST_DIR: 'apps/web/dist',
            PORT: '3000',
          },
        },
      ]
    : [
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
