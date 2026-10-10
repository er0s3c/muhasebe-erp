import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Derlenmiş web arayüzünü (Vite çıktısı) API ile aynı kökenden sunar: çerez yolu (`/api/auth`) ve göreli
 * `/api/...` istekleri ek bir ters vekil olmadan çalışır. Yalnızca `WEB_DIST_DIR` verilmişse kaydedilir.
 *
 * - `/assets/*` içerik özetli adlar taşır: 1 yıl, değişmez. `index.html` her zaman doğrulanır (yeni sürüm hemen görülsün).
 * - SPA yedeği (`index.html`) yalnızca `/api/` dışı, uzantısız ve HTML isteyen GET isteklerine verilir;
 *   olmayan bir `/assets/x.js` gerçek 404 alır (dağıtım sonrası eski sekmeler HTML'i betik sanıp MIME hatası vermesin).
 */
export async function registerWebApp(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: resolve(webDir),
    prefix: '/',
    index: 'index.html',
    // Derlemede üretilen .br/.gz kopyaları (apps/web/scripts/precompress.mjs) tarayıcı kabul ediyorsa doğrudan sunulur
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply, filePath) {
      const normalized = filePath.replaceAll('\\', '/');
      if (normalized.includes('/assets/')) void reply.header('cache-control', 'public, max-age=31536000, immutable');
      else if (normalized.endsWith('/index.html')) void reply.header('cache-control', 'no-cache');
      else void reply.header('cache-control', 'public, max-age=300');
    },
  });
}

/** Web arayüzü sunulurken 404 işleyicisi: sayfa istekleri `index.html`, gerisi JSON 404 alır. */
export function webNotFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split('?')[0]!;
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  const isPage = req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path) && wantsHtml;
  if (isPage) {
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  }
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı' } });
}
