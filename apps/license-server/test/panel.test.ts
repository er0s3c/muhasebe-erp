import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { buildApp } from '../src/app';
import { ephemeralSigner } from '../src/signer';
import { afterAll } from 'vitest';

const dist = mkdtempSync(join(tmpdir(), 'erp-panel-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><script src="/theme-init.js"></script></head><body><div id="root">PANEL-INDEX</div></body></html>');
writeFileSync(join(dist, 'assets', 'panel-abc123.js'), 'console.log("panel");');
writeFileSync(join(dist, 'theme-init.js'), 'document.documentElement.dataset.t = "1";');

async function make(panelDir?: string) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    LICENSE_DATA_KEY: 'test-data-key-test-data-key-test-data-key',
    RATE_LIMIT_ENABLED: 'false',
    ...(panelDir ? { PANEL_DIST_DIR: panelDir } : {}),
  });
  const handle = createDb(config.DATABASE_URL);
  const app = await buildApp({ db: handle.db, config, signer: ephemeralSigner('k-test'), logger: false });
  await app.ready();
  afterAll(async () => {
    await app.close();
    await handle.close();
  });
  return app;
}

describe('yönetim paneli sunumu (PANEL_DIST_DIR)', async () => {
  const app = await make(dist);
  const html = { accept: 'text/html,application/xhtml+xml' };

  it('kök ve derin bağlantılar index.html döner (her seferinde doğrulanır)', async () => {
    for (const url of ['/', '/login', '/licenses/123e4567-e89b-12d3-a456-426614174000?x=1']) {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('PANEL-INDEX');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('API ve genel uçlar SPA yedeğinden etkilenmez: olmayan /admin/api ve /v1 yolları JSON 404, /healthz çalışır', async () => {
    for (const url of ['/admin/api/yok', '/v1/yok']) {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().ok).toBe(true);
    // korumalı uç panel dosyalarıyla karışmaz
    expect((await app.inject({ method: 'GET', url: '/admin/api/dashboard' })).statusCode).toBe(401);
  });

  it('olmayan varlık gerçek 404, özetli varlık değişmez önbellek, güvenlik başlıkları var', async () => {
    const missing = await app.inject({ method: 'GET', url: '/assets/eski-abc.js', headers: html });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('PANEL-INDEX');
    const asset = await app.inject({ method: 'GET', url: '/assets/panel-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const index = await app.inject({ method: 'GET', url: '/', headers: html });
    expect(String(index.headers['content-security-policy'])).toContain("script-src 'self'");
    // POST istekleri SPA yedeği almaz
    expect((await app.inject({ method: 'POST', url: '/licenses', headers: html })).statusCode).toBe(404);
  });
});

describe('PANEL_DIST_DIR verilmezse panel sunulmaz', async () => {
  const app = await make();
  it('bilinmeyen yollar JSON 404 döner', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
  });
});
