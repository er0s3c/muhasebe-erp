import type { FastifyInstance } from 'fastify';
import { enqueueEmail } from '../outbox/service';
import { scanAll, type ScanOptions } from './scan';

/** Uygulama ayarlarından tarama seçenekleri (zamanlayıcı ve elle tarama aynı seçenekleri kullanır). */
export function notificationScanOptions(app: FastifyInstance): ScanOptions {
  const c = app.config;
  return {
    license: async () => {
      if (!app.license.enforced) return null;
      const s = await app.license.current();
      return { enforced: s.enforced, state: s.state, daysUntilExpiry: s.daysUntilExpiry ?? null };
    },
    // E-posta yalnızca SMTP (ya da geliştirme günlük kipi) yapılandırılmışsa: kapalıysa özet hiç üretilmez. Özet kalıcı outbox'a
    // yazılır (kullanıcı + gün başına tek ileti); gönderim ve yeniden deneme outbox göndericisindedir.
    persistMail: app.mailer.enabled
      ? async (tx, m, meta) => {
          await enqueueEmail(tx, { companyId: meta.companyId, kind: 'notification_digest', dedupeKey: `digest:${meta.userId}:${meta.date}`, recipient: m.to, subject: m.subject, bodyText: m.text, bodyHtml: m.html ?? null });
        }
      : undefined,
    baseUrl: c.APP_BASE_URL,
    retentionDays: c.NOTIFY_RETENTION_DAYS,
    digestHour: c.NOTIFY_DIGEST_HOUR,
    log: app.log,
  };
}

/**
 * Bildirim zamanlayıcısı: her `NOTIFY_INTERVAL_MINUTES` dakikada tüm şirketleri tarar. Çok örnekli kurulumda aynı şirketi iki örnek
 * aynı anda taramaz (şirket başına PostgreSQL advisory kilidi; kilidi alamayan örnek o şirketi atlar) ve veritabanı kısıtı kopyayı
 * zaten engeller. Önceki tur bitmeden yeni tur başlamaz. Durdurma işlevini döndürür.
 */
export function startNotificationScheduler(app: FastifyInstance): () => void {
  const c = app.config;
  if (!c.NOTIFY_ENABLED) {
    app.log.info('bildirim zamanlayıcısı kapalı (NOTIFY_ENABLED=false)');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await scanAll(app.db, notificationScanOptions(app));
      if (r.created > 0 || r.resolved > 0 || r.pruned > 0 || r.digests > 0 || r.errors > 0) app.log.info(r, 'bildirim taraması tamam');
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bildirim taraması başarısız');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 20_000 + Math.random() * 20_000);
  const timer = setInterval(() => void tick(), c.NOTIFY_INTERVAL_MINUTES * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
