import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

describe('çevrimdışı kabuk üretim HTML sunumuyla hazırlanır', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'erp-offline-shell-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">Offline shell</div>');
  writeFileSync(join(dist, 'favicon.png'), 'icon');
  writeFileSync(join(dist, 'theme-init.js'), '/* theme */');
  const { app } = await makeApp({ configOverrides: { WEB_DIST_DIR: dist } });

  it('HTML kabul başlığı gönderir, API ve dış kökenleri saklamaz, bağlantısız açılışı sunar', async () => {
    const origin = 'http://localhost';
    const handlers = new Map<string, (event: unknown) => void>();
    const entries = new Map<string, Response>();
    const requested: string[] = [];
    let offline = false;
    const path = (input: string | { url: string }) => new URL(typeof input === 'string' ? input : input.url, origin).pathname;
    runInNewContext(readFileSync(resolve(__dirname, '../../web/public/field-sw.js'), 'utf8'), {
      URL, Response,
      self: { location: { origin }, addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler) },
      caches: { open: async () => ({
        put: async (input: string, response: Response) => entries.set(path(input), response.clone()),
        match: async (input: string | { url: string }) => entries.get(path(input))?.clone(),
      }) },
      fetch: async (input: string, options?: { headers?: Record<string, string> }) => {
        if (offline) throw new Error('offline');
        requested.push(path(input));
        const response = await app.inject({ method: 'GET', url: path(input), headers: options?.headers });
        return new Response(response.body, { status: response.statusCode });
      },
    });
    let prepared: Promise<void> | undefined;
    let reply: { ok: boolean } | undefined;
    handlers.get('message')!({
      data: { type: 'prepare', urls: ['/api/private-records', 'https://other.example/private.js'] },
      ports: [{ postMessage: (message: { ok: boolean }) => { reply = message; } }],
      waitUntil: (task: Promise<void>) => { prepared = task; },
    });
    await prepared;
    expect(reply).toEqual({ ok: true });
    expect(requested).toEqual(expect.arrayContaining(['/field-offline', '/favicon.png', '/theme-init.js']));
    expect(requested).not.toContain('/api/private-records');
    expect(requested).not.toContain('/private.js');
    offline = true;
    let result: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: { method: 'GET', url: `${origin}/field-offline`, mode: 'navigate' },
      respondWith: (response: Promise<Response>) => { result = response; },
    });
    expect(await (await result)!.text()).toContain('Offline shell');
  });
});
