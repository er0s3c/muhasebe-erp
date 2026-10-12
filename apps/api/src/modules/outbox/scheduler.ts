import type { FastifyInstance } from 'fastify';
import { dispatchEmailOutbox } from './service';

/**
 * E-posta outbox göndericisi: her `OUTBOX_INTERVAL_SECONDS` saniyede bekleyen iletileri gönderir. Önceki tur bitmeden yenisi
 * başlamaz; çok örnekli kurulumda kira (lease) aynı iletinin iki kez alınmasını engeller. Durdurma işlevini döndürür.
 */
export function startOutboxDispatcher(app: FastifyInstance): () => void {
  const c = app.config;
  if (!c.OUTBOX_ENABLED || !app.mailer.enabled) {
    app.log.info('e-posta outbox göndericisi kapalı');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await dispatchEmailOutbox(app.db, app.mailer);
      if (r.delivered > 0 || r.failed > 0 || r.deadLetter > 0) app.log.info(r, 'e-posta outbox turu');
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'e-posta outbox turu başarısız');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 10_000);
  const timer = setInterval(() => void tick(), c.OUTBOX_INTERVAL_SECONDS * 1000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
