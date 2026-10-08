import { defineConfig, devices } from '@playwright/test';

/**
 * Uçtan uca testler gerçek API + gerçek PostgreSQL + Vite geliştirme sunucusu ile çalışır.
 * Önce `npm run db:migrate` çalıştırılmış olmalıdır. Ortamda hazır bir Chromium varsa
 * PW_CHROMIUM_PATH ile gösterilebilir (indirme yapılmaz).
 */
// E2E_TARGET=bundle: geliştirme sunucuları yerine ÜRETİM paketini sınar (`npm run build` sonrası
// `node apps/api/dist/server.js`; arayüzü API aynı kökenden sunar, CSP ve önbellek başlıkları dahil).
const bundle = process.env.E2E_TARGET === 'bundle';
const apiPort = Number(process.env.E2E_API_PORT ?? 3000),
  webPort = Number(process.env.E2E_WEB_PORT ?? 5173);
if (![apiPort, webPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535))
  throw new Error('Geçersiz E2E portu');
const apiUrl = `http://localhost:${apiPort}`,
  webUrl = `http://localhost:${webPort}`;
const reuse = process.env.E2E_ISOLATED !== '1';

export default defineConfig({
  testDir: '.',
  testIgnore: ['**/.claude/**', '**/.codex/**', '**/node_modules/**'],
  testMatch: ['e2e/**/*.spec.ts', 'lisans-server/e2e/**/*.spec.ts'],
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'test-results',
  // CI çalıştırıcıları yerel makineden yavaştır; en uzun senaryo (kasa/banka) orada 60 sn'yi aşıyordu.
  timeout: process.env.CI ? 150_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: bundle ? 'http://localhost:3000' : webUrl,
    locale: 'tr-TR',
    timezoneId: 'Europe/Nicosia',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: bundle
    ? [
        {
          command: 'node --env-file-if-exists=.env --enable-source-maps apps/api/dist/server.js',
          url: 'http://localhost:3000/api/health/ready',
          reuseExistingServer: false,
          timeout: 60_000,
          // Sunucu çıktısı (yalnızca uyarı/hata) test günlüğüne karışır: CI'da kırılan bir senaryonun nedeni okunabilsin.
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            NODE_ENV: 'production',
            JWT_SECRET: 'e2e-bundle-jwt-key-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
            RATE_LIMIT_ENABLED: 'false',
            WEB_DIST_DIR: 'apps/web/dist',
            PORT: '3000',
            LOG_LEVEL: 'warn',
          },
        },
      ]
    : [
        {
          command: 'npm run start -w @erp/api',
          url: apiUrl + '/api/health',
          reuseExistingServer: reuse,
          timeout: 60_000,
          env: { RATE_LIMIT_ENABLED: 'false', PORT: String(apiPort), CORS_ORIGIN: webUrl },
        },
        {
          command: `npm run dev -w @erp/web -- --port ${webPort}`,
          url: webUrl,
          reuseExistingServer: reuse,
          timeout: 60_000,
          env: { VITE_API_TARGET: apiUrl },
        },
      ],
});
