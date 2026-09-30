import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

const dist = mkdtempSync(join(tmpdir(), 'erp-web-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><script src="/theme-init.js"></script></head><body><div id="root">ERP-INDEX</div></body></html>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("app");');
writeFileSync(join(dist, 'theme-init.js'), 'document.documentElement.dataset.t = "1";');

describe('derlenmiş web arayüzü sunumu (WEB_DIST_DIR)', async () => {
  const { app } = await makeApp({ configOverrides: { WEB_DIST_DIR: dist } });
  const html = { accept: 'text/html,application/xhtml+xml' };

  it('derin bağlantı ve kök index.html döner; her seferinde doğrulanır (no-cache)', async () => {
    for (const url of ['/', '/invoices/sales', '/parties/123e4567-e89b-12d3-a456-426614174000?tab=ekstre']) {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('ERP-INDEX');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(String(res.headers['content-type'])).toContain('text/html');
    }
  });

  it('/api altındaki olmayan uç, HTML isteyen tarayıcıya bile JSON 404 verir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/yok', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok' });
  });

  it('olmayan varlık dosyası gerçek 404 alır (HTML dönmez); GET dışı istekler de JSON 404', async () => {
    const missing = await app.inject({ method: 'GET', url: '/assets/eski-abc.js', headers: html });
    expect(missing.statusCode).toBe(404);
    expect(String(missing.headers['content-type'])).toContain('application/json');
    expect(missing.body).not.toContain('ERP-INDEX');
    const post = await app.inject({ method: 'POST', url: '/invoices/sales', headers: html });
    expect(post.statusCode).toBe(404);
    // HTML istemeyen (ör. fetch/betik) uzantısız istek de SPA yedeği almaz
    expect((await app.inject({ method: 'GET', url: '/invoices/sales', headers: { accept: 'application/json' } })).statusCode).toBe(404);
  });

  it('içerik özetli varlıklar 1 yıl değişmez; diğer dosyalar kısa süre önbelleğe alınır', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(String(asset.headers['content-type'])).toContain('javascript');
    const theme = await app.inject({ method: 'GET', url: '/theme-init.js' });
    expect(theme.statusCode).toBe(200);
    expect(theme.headers['cache-control']).toBe('public, max-age=300');
  });

  it('güvenlik başlıkları arayüz yanıtlarında da bulunur (betik yalnızca kendi kökeninden)', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: html });
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('WEB_DIST_DIR verilmezse arayüz sunulmaz', async () => {
  const { app } = await makeApp();
  it('bilinmeyen yollar JSON 404 döner', async () => {
    const res = await app.inject({ method: 'GET', url: '/invoices/sales', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
