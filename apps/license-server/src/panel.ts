import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Derlenmiş yönetim panelini (apps/license-admin) lisans sunucusuyla aynı kökenden sunar (çerez ve CSRF denetimi aynı
 * kökende çalışsın). Yalnızca `PANEL_DIST_DIR` verilmişse kaydedilir. Ters vekil (Caddy) panel yollarını IP ile kısıtlar;
 * yalnızca `/v1/*` ve `/healthz` herkese açıktır.
 *
 * - `/assets/*` içerik özetli adlar taşır (1 yıl, değişmez); `index.html` her zaman doğrulanır.
 * - SPA yedeği yalnızca `/admin/api`, `/v1` ve `/healthz` dışı, uzantısız ve HTML isteyen GET isteklerine verilir.
 */
export async function registerPanel(app: FastifyInstance, dir: string): Promise<void> {
  if (!existsSync(dir)) throw new Error(`PANEL_DIST_DIR bulunamadı: ${dir}`);
  await app.register(fastifyStatic, {
    root: resolve(dir),
    prefix: '/',
    index: 'index.html',
    cacheControl: false,
    setHeaders(reply, filePath) {
      const normalized = filePath.replaceAll('\\', '/');
      if (normalized.includes('/assets/')) void reply.header('cache-control', 'public, max-age=31536000, immutable');
      else if (normalized.endsWith('/index.html')) void reply.header('cache-control', 'no-cache');
      else void reply.header('cache-control', 'public, max-age=300');
    },
  });
}

/** Panel sunulurken 404 işleyicisi: sayfa istekleri `index.html`, gerisi JSON 404 alır. */
export function panelNotFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split('?')[0]!;
  const api = path.startsWith('/admin/api') || path.startsWith('/v1/') || path === '/healthz';
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (req.method === 'GET' && !api && !/\.[a-z0-9]+$/i.test(path) && wantsHtml) {
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  }
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı' } });
}
