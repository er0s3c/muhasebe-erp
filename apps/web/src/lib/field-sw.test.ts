// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDirectory = new URL('../../public/', import.meta.url);
const source = readFileSync(new URL('field-sw.js', publicDirectory), 'utf8');
function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const entries = new Map<string, Response>();
  const fetch = vi.fn().mockResolvedValue(new Response('network'));
  const put = vi.fn(async (url: string, response: Response) => { entries.set(url, response); });
  const addAll = vi.fn(async (urls: string[]) => { for (const url of urls) entries.set(url, new Response(url)); });
  const cache = { addAll, put, match: vi.fn(async (input: string | { url: string }) => entries.get(typeof input === 'string' ? input : new URL(input.url).pathname)) };
  const self = { location: { origin: 'https://erp.example' }, skipWaiting: vi.fn(), clients: { claim: vi.fn() }, addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener) };
  runInNewContext(source, { self, caches: { open: async () => cache }, fetch, URL, Response });
  const dispatch = (type: string, values = {}) => {
    let pending: Promise<unknown> | undefined;
    const respondWith = vi.fn((promise: Promise<Response>) => { pending = promise; });
    listeners.get(type)!({ ...values, waitUntil: (promise: Promise<unknown>) => { pending = promise; }, respondWith });
    return { pending, respondWith };
  };
  const request = (path: string, method = 'GET', mode = 'cors') => dispatch('fetch', { request: { url: new URL(path, self.location.origin).href, method, mode } });
  return { self, fetch, cache, entries, dispatch, request };
}

describe('PWA saha worker güvenliği ve çevrimdışı davranış', () => {
  it('kurulum yalnız herkese açık dosyaları önbelleğe alır', async () => {
    const w = worker(); await w.dispatch('install').pending;
    expect(w.cache.addAll).toHaveBeenCalledExactlyOnceWith(['/offline.html', '/app-icon.svg', '/manifest.webmanifest']);
    expect(w.self.skipWaiting).toHaveBeenCalledOnce(); await w.dispatch('activate').pending; expect(w.self.clients.claim).toHaveBeenCalledOnce();
  });
  it.each(['/api/me', '/api/pos/catalog?barcode=8691234567890', '/api/invoices', 'https://other.example/private'])('API/dış köken isteğine müdahale etmez: %s', async path => {
    const w = worker(); const event = w.request(path); expect(event.respondWith).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled(); expect(w.cache.match).not.toHaveBeenCalled();
  });
  it('yazma istekleri önbellekten karşılanmaz', () => {
    const w = worker(); expect(w.request('/api/pos/sales', 'POST').respondWith).not.toHaveBeenCalled();
    expect(w.request('/field-offline', 'POST').respondWith).not.toHaveBeenCalled();
  });
  it('saha paketi hazırlanırken API ve dış köken dosyaları dışarıda kalır', async () => {
    const w = worker(); const postMessage = vi.fn();
    await w.dispatch('message', { data: { type: 'prepare', urls: ['/assets/app.js', '/api/me', '/api/attachments/1', 'https://other.example/file.js'] }, ports: [{ postMessage }] }).pending;
    expect([...w.entries.keys()]).toEqual(['/field-offline', '/favicon.png', '/theme-init.js', '/assets/app.js']);
    expect(w.fetch).toHaveBeenCalledWith('/field-offline', { headers: { Accept: 'text/html' } }); expect(postMessage).toHaveBeenCalledWith({ ok: true });
  });
  it('çevrimiçi uygulama yanıtını kullanıcı verileriyle birlikte önbelleğe yazmaz', async () => {
    const w = worker(); const response = await w.request('/invoices').pending as Response;
    expect(await response.text()).toBe('network'); expect(w.cache.put).not.toHaveBeenCalled();
  });
  it('genel taslak ekranını HTML olarak hazırlayıp bağlantı kesilince açar', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'prepare', urls: ['/offline-drafts', '/assets/offline.js', '/api/offline-drafts/bootstrap'] }, ports: [] }).pending;
    expect(w.fetch).toHaveBeenCalledWith('/offline-drafts', { headers: { Accept: 'text/html' } });
    expect(w.entries.has('/api/offline-drafts/bootstrap')).toBe(false);
    w.fetch.mockRejectedValue(new TypeError('offline'));
    expect(await (await w.request('/offline-drafts?device=1', 'GET', 'navigate').pending as Response).text()).toBe('network');
  });
  it('çevrimdışında hazırlanmış saha sayfası, genel bilgi sayfası ve dosya yok durumu ayrılır', async () => {
    const w = worker(); w.fetch.mockRejectedValue(new TypeError('offline'));
    w.entries.set('/offline.html', new Response('offline')); w.entries.set('/field-offline', new Response('field package'));
    expect(await (await w.request('/field-offline', 'GET', 'navigate').pending as Response).text()).toBe('field package');
    expect(await (await w.request('/pos', 'GET', 'navigate').pending as Response).text()).toBe('offline');
    expect((await w.request('/assets/unknown.js').pending as Response).status).toBe(503);
  });
  it('yüklenebilir manifest yerel ikon ve Türkçe başlangıç sayfasına bağlıdır', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', publicDirectory), 'utf8'));
    expect(manifest).toMatchObject({ lang: 'tr', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(existsSync(fileURLToPath(new URL(icon.src.slice(1), publicDirectory)))).toBe(true);
  });
});
