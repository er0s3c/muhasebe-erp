import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Oturum geçersiz veya süresi dolmuş') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Bu işlem için yetkiniz yok', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (what = 'Kayıt') => new AppError(404, 'NOT_FOUND', `${what} bulunamadı`);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const unprocessable = (message: string, code: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** pg hatasına (Drizzle sarmalayıcısının `cause`'u dahil) ulaşır. */
function pgError(err: unknown): { code?: string; message: string; constraint?: string } | null {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur && typeof (cur as { code: unknown }).code === 'string') {
      const c = cur as { code: string; message: string; constraint?: string };
      if (/^[0-9A-Z]{5}$/.test(c.code)) return c;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function errorHandler(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    void reply
      .status(err.status)
      .send({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof z.ZodError) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Geçersiz istek verisi',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  const pg = pgError(err);
  if (pg?.code === 'ERP01') {
    // Veritabanı iş kuralı tetikleyicilerimiz (değiştirilemez defter vb.)
    void reply
      .status(422)
      .send({ error: { code: 'LEDGER_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP02') {
    // Stok defteri kuralları (yetersiz stok, değiştirilemez hareket, kapalı dönem vb.)
    void reply
      .status(422)
      .send({ error: { code: 'STOCK_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP03') {
    // Fatura kuralları (değiştirilemez fatura, toplam/yevmiye tutarsızlığı vb.)
    void reply
      .status(422)
      .send({ error: { code: 'INVOICE_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP04') {
    // İrsaliye kuralları (değiştirilemez irsaliye, stok defteriyle tutarsızlık, faturalı irsaliye iptali vb.)
    void reply
      .status(422)
      .send({ error: { code: 'DELIVERY_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP05') {
    // Kasa/banka kuralları (değiştirilemez hareket, yevmiye/tutar tutarsızlığı, eşleştirme aşımı vb.)
    void reply
      .status(422)
      .send({ error: { code: 'TREASURY_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP06') {
    // Banka ekstresi kuralları (değiştirilemez satır, tutar/işaret uyuşmazlığı, eşleşmiş fişin ters çevrilmesi vb.)
    void reply
      .status(422)
      .send({ error: { code: 'BANK_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP07') {
    // Denetim kaydı yalnızca eklenir (sahip rolü dahil değiştirilemez/silinemez)
    void reply
      .status(422)
      .send({ error: { code: 'AUDIT_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP08') {
    // Lisans durumu kuralları (silinemez, kurulum kimliği sabit, saat işareti geri gitmez)
    void reply
      .status(422)
      .send({ error: { code: 'LICENSE_STATE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP09') {
    // Proje kuralları (yaprak olmayan iş kalemi, kapalı projeye kayıt, değiştirilemez onaylı bütçe vb.)
    void reply
      .status(422)
      .send({ error: { code: 'PROJECT_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP10') {
    // Taşeron/onay kuralları (değiştirilemez karar, kaydedilmiş hakediş vb.)
    void reply
      .status(422)
      .send({ error: { code: 'SUBCONTRACT_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP12') {
    // Gayrimenkul satışı kuralları (birim durumu, sözleşme geçişleri, kilitli taksit planı, fesih)
    void reply
      .status(422)
      .send({ error: { code: 'REAL_ESTATE_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP11') {
    // Satın alma kuralları (talep, RFQ, sipariş, mal kabul)
    void reply
      .status(422)
      .send({ error: { code: 'PROCUREMENT_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP13') {
    // İnsan kaynakları/kişisel veri/puantaj kuralları (personel silinmez, erişim günlüğü değişmez, sonuçlanmış talep, kapalı puantaj ayı, çalışma aralığı)
    void reply
      .status(422)
      .send({ error: { code: 'HR_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === 'ERP14') {
    // Çek/senet ve teminat mektubu kuralları (geçersiz durum geçişi, değişmez geçmiş, eşleştirme aşımı, sonuçlanmış mektup)
    void reply
      .status(422)
      .send({ error: { code: 'CHEQUE_RULE_VIOLATION', message: pg.message } });
    return;
  }
  if (pg?.code === '23505') {
    void reply
      .status(409)
      .send({ error: { code: 'DUPLICATE', message: 'Bu kayıt zaten mevcut', details: pg.constraint } });
    return;
  }
  if (pg?.code === '23514') {
    void reply
      .status(422)
      .send({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Değer izin verilen aralığın dışında', details: pg.constraint } });
    return;
  }
  if (pg?.code === '40001' || pg?.code === '40P01') {
    // Serileştirme hatası / kilitlenme: işlem geri alındı, aynı istek yeniden denenebilir.
    void reply
      .status(409)
      .send({ error: { code: 'RETRY', message: 'Eşzamanlı işlem çakışması; lütfen tekrar deneyin' } });
    return;
  }
  if (pg?.code === '22P02') {
    void reply
      .status(400)
      .send({ error: { code: 'INVALID_INPUT', message: 'Geçersiz değer biçimi' } });
    return;
  }
  if (pg?.code === '23503') {
    void reply
      .status(409)
      .send({ error: { code: 'REFERENCED', message: 'İlişkili kayıtlar nedeniyle işlem yapılamaz' } });
    return;
  }

  const fastifyStatus = (err as FastifyError).statusCode;
  if (fastifyStatus === 429) {
    void reply
      .status(429)
      .send({ error: { code: 'RATE_LIMITED', message: 'Çok fazla istek; lütfen biraz sonra tekrar deneyin' } });
    return;
  }
  if (fastifyStatus && fastifyStatus >= 400 && fastifyStatus < 500) {
    void reply
      .status(fastifyStatus)
      .send({ error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message } });
    return;
  }

  req.log.error({ err }, 'beklenmeyen hata');
  void reply
    .status(500)
    .send({ error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu' } });
}
