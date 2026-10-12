/**
 * Ortak outbox sözleşmesi (öneri 111). Dış gönderimler (imzalı webhook, e-posta) iş kaydıyla AYNI işlemde kuyruğa yazılır;
 * gönderici ayrı işlemde kira (lease) alarak bir kaydı talep eder, gönderimi işlem DIŞINDA yapar ve sonucu yalnız kendi
 * kirası geçerliyse yazar. Süreç gönderim sırasında çökerse kira dolar, kayıt yeniden talep edilir (en az bir kez teslim;
 * alıcı tarafı olay kimliğiyle tekrarı ayıklar). Durum makinesi:
 *
 *   pending ──talep──▶ sending ──başarı──▶ delivered
 *      ▲                  │
 *      └──hata (deneme<sınır)──┘   hata (deneme=sınır) ──▶ dead_letter      (elle yeniden deneme: dead_letter ──▶ pending)
 *   pending/dead_letter ──iptal──▶ cancelled
 */
export const OUTBOX_STATUSES = ['pending', 'sending', 'delivered', 'dead_letter', 'cancelled'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Denemeler arası bekleme: 30 sn, 2 dk, 10 dk, 1 sa, 6 sa (sonrakiler 6 sa). */
export const OUTBOX_RETRY_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
/** Kira süresi: bu süre içinde sonuç yazılmazsa kayıt yeniden talep edilebilir. */
export const OUTBOX_LEASE_MS = 60_000;

/** `attempts` denemesi başarısız olduktan sonraki deneme zamanı. */
export function outboxRetryAt(attempts: number, now: Date): Date {
  const wait = OUTBOX_RETRY_MS[Math.min(Math.max(attempts, 1) - 1, OUTBOX_RETRY_MS.length - 1)]!;
  return new Date(now.getTime() + wait);
}

/**
 * Bir gönderim denemesinin sonucu → kayıt alanları. `attempts` bu deneme dahil yapılan deneme sayısıdır; sınıra ulaşan
 * başarısız kayıt `dead_letter` olur ve zamanlayıcı onu bir daha almaz.
 */
export function outboxOutcome(attempts: number, maxAttempts: number, error: string | null, now: Date) {
  if (!error) return { status: 'delivered' as const, deliveredAt: now, nextAttemptAt: now, lastError: null };
  return {
    status: attempts >= maxAttempts ? ('dead_letter' as const) : ('pending' as const),
    deliveredAt: null,
    nextAttemptAt: outboxRetryAt(attempts, now),
    lastError: error.slice(0, 500),
  };
}
