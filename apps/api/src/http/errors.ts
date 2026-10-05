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

/** Hata zincirinde (cause) verilen koşulu sağlayan bir halka var mı. */
function someInChain(err: unknown, pred: (e: { message?: unknown; code?: unknown; name?: unknown }) => boolean): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if (pred(cur as { message?: unknown; code?: unknown })) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

const AMOUNT_OUT_OF_RANGE_MESSAGE = 'Tutar izin verilen aralığı aşıyor: hesaplanan tutar (miktar × fiyat, kur karşılığı) en çok 15 tam basamak olabilir';

/**
 * Veritabanı iş kuralı tetikleyicilerinin SQLSTATE kodları (`RAISE ... USING ERRCODE = 'ERPnn'`) → API hata kodu.
 * İleti tetikleyicinin kendi Türkçe iletisidir. `errorHandler` ve toplu işlem raporu (`describeError`) aynı tabloyu kullanır;
 * göçlerde kullanılan her kodun burada olduğu testle denetlenir (API-8).
 */
export const PG_RULE_CODES: Readonly<Record<string, string>> = {
  ERP01: 'LEDGER_RULE_VIOLATION', // değiştirilemez defter, dengesiz fiş, kapalı dönem
  ERP02: 'STOCK_RULE_VIOLATION', // yetersiz stok, değiştirilemez hareket
  ERP03: 'INVOICE_RULE_VIOLATION', // değiştirilemez fatura, toplam/yevmiye tutarsızlığı
  ERP04: 'DELIVERY_RULE_VIOLATION', // değiştirilemez irsaliye, faturalı irsaliye iptali
  ERP05: 'TREASURY_RULE_VIOLATION', // kasa/banka hareketi, eşleştirme aşımı
  ERP06: 'BANK_RULE_VIOLATION', // banka ekstresi satırları
  ERP07: 'AUDIT_RULE_VIOLATION', // denetim kaydı yalnızca eklenir
  ERP08: 'LICENSE_STATE_VIOLATION', // lisans durumu
  ERP09: 'PROJECT_RULE_VIOLATION', // iş kalemi, kapalı proje, onaylı bütçe
  ERP10: 'SUBCONTRACT_RULE_VIOLATION', // taşeron, hakediş, onay kararları
  ERP11: 'PROCUREMENT_RULE_VIOLATION', // talep, RFQ, sipariş, mal kabul
  ERP12: 'REAL_ESTATE_RULE_VIOLATION', // birim, sözleşme, taksit planı, fesih
  ERP13: 'HR_RULE_VIOLATION', // personel, kişisel veri, puantaj
  ERP14: 'CHEQUE_RULE_VIOLATION', // çek/senet, teminat mektubu
  ERP15: 'SALES_RULE_VIOLATION', // teklif/sipariş, toplu faturalama
  ERP16: 'PRICE_RULE_VIOLATION', // fiyat listesi, cari özel fiyat
  ERP17: 'SERIAL_RULE_VIOLATION', // seri numaraları
  ERP18: 'IMPORT_RULE_VIOLATION', // ithalat maliyet dağıtımı
  ERP19: 'EXPENSE_RULE_VIOLATION', // gider kartı/fişi
  ERP20: 'EMPLOYEE_LEDGER_RULE_VIOLATION', // personel cari, avans
  ERP21: 'DIRECTORY_RULE_VIOLATION', // rehber
  ERP22: 'CONSOLIDATION_RULE_VIOLATION', // konsolidasyon
  ERP23: 'FISCAL_YEAR_RULE_VIOLATION', // mali yıl kapanışı
  ERP24: 'SETTINGS_RULE_VIOLATION', // KDV oranı, kur
  ERP25: 'NOTIFICATION_RULE_VIOLATION', // bildirim satırı değiştirilemez, kapanmamış bildirim silinemez
  ERP26: 'MODULE_ACCESS_RULE_VIOLATION', // kullanıcı bazlı modül erişimi: kendi erişimi, sahip, yönetici rütbesi
};

/** Benzersizlik kısıtı adından kullanıcıya gösterilecek alan ve ileti (kısıt adı yanıtta yer almaz; API-10). */
export function duplicateField(constraint: string | undefined): { field: string; message: string } | null {
  if (!constraint) return null;
  const used = (label: string) => `Bu ${label} zaten kullanılıyor`;
  const rules: [RegExp, string, string][] = [
    [/^(price_list_items|party_prices)_uq$/, 'itemId', 'Bu ürün için aynı alt miktar ve başlangıç tarihli fiyat zaten var'],
    [/^exchange_rates_uq$/, 'rateDate', 'Bu tarih ve para birimi için kur zaten girilmiş'],
    [/^memberships_/, 'userId', 'Kullanıcı bu şirkete zaten üye'],
    [/email/, 'email', used('e-posta adresi')],
    [/barcode/, 'barcode', used('barkod')],
    [/external_no/, 'externalNo', used('belge numarası')],
    [/^tax_rates_uq$/, 'code', used('KDV oranı kodu')],
    [/_(no|number)_uq$/, 'number', used('numara')],
    [/code_uq$/, 'code', used('kod')],
    [/name_uq$/, 'name', used('ad')],
    [/month_uq$/, 'month', 'Bu dönem için kayıt zaten var'],
  ];
  for (const [re, field, message] of rules) if (re.test(constraint)) return { field, message };
  return null;
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  headers?: Record<string, string>;
  /** Günlüğe uyarı olarak yazılsın (beklenmeyen ama istemciye açıklanabilir durumlar). */
  warn?: boolean;
}

const BUSY: MappedError = {
  status: 503,
  code: 'BUSY',
  message: 'Sunucu şu anda çok yoğun ya da veritabanına ulaşılamıyor; birkaç saniye sonra tekrar deneyin',
  headers: { 'retry-after': '3' },
  warn: true,
};

/** Fastify'ın kendi hata kodları → Türkçe ileti (API-9). */
const FASTIFY_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'İstek gövdesi geçerli bir JSON değil',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'İstek gövdesi boş; JSON bekleniyor',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Desteklenmeyen içerik türü; istek gövdesi application/json olmalı',
  FST_ERR_CTP_BODY_TOO_LARGE: 'İstek gövdesi çok büyük',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'İstek gövdesinin uzunluğu Content-Length başlığıyla uyuşmuyor',
  FST_ERR_BAD_URL: 'Geçersiz adres',
  FST_ERR_ASYNC_CONSTRAINT: 'Geçersiz istek',
  FORBIDDEN_JSON_KEY: 'İstek gövdesinde izin verilmeyen bir alan adı var (__proto__ ya da constructor.prototype)',
};

/** SQLSTATE sınıf 22 (veri istisnaları): kullanıcı girdisinden kaynaklanır → 400 (API-4). */
function dataException(code: string): MappedError | null {
  if (!code.startsWith('22')) return null;
  switch (code) {
    case '22003':
      // Sayısal taşma: hesaplanan tutar (miktar × fiyat, × kur) numeric(19,4) sütununa sığmıyor (ACC-8)
      return { status: 400, code: 'AMOUNT_OUT_OF_RANGE', message: AMOUNT_OUT_OF_RANGE_MESSAGE };
    case '22001':
      return { status: 400, code: 'VALUE_TOO_LONG', message: 'Metin izin verilen uzunluğu aşıyor' };
    case '22007':
    case '22008':
      return { status: 400, code: 'INVALID_DATE', message: 'Geçersiz ya da desteklenen aralığın dışında tarih' };
    case '22021':
    case '22P05':
      return { status: 400, code: 'INVALID_TEXT', message: 'Metinde geçersiz karakter var' };
    case '22P02':
      return { status: 400, code: 'INVALID_INPUT', message: 'Geçersiz değer biçimi' };
    default:
      return { status: 400, code: 'INVALID_INPUT', message: 'Geçersiz değer', warn: true };
  }
}

/**
 * Bir hatayı HTTP yanıtına eşler; tanınmayan (gerçekten beklenmeyen) hatada `null` döner. Tek doğruluk kaynağı:
 * `errorHandler` ve toplu işlemlerin satır hatası raporu (`describeError`) bunu kullanır (API-8).
 */
export function mapError(err: unknown): MappedError | null {
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message, details: err.details };

  if (err instanceof z.ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Geçersiz istek verisi',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  const pg = pgError(err);
  if (pg?.code) {
    const rule = PG_RULE_CODES[pg.code];
    if (rule) return { status: 422, code: rule, message: pg.message };
    if (pg.code === '23505') {
      const f = duplicateField(pg.constraint);
      return f
        ? { status: 409, code: 'DUPLICATE', message: f.message, details: { field: f.field } }
        : { status: 409, code: 'DUPLICATE', message: 'Bu kayıt zaten mevcut' };
    }
    if (pg.code === '23514') return { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'Değer izin verilen aralığın dışında' };
    if (pg.code === '23503') return { status: 409, code: 'REFERENCED', message: 'İlişkili kayıtlar nedeniyle işlem yapılamaz' };
    if (pg.code === '23502') return { status: 400, code: 'REQUIRED', message: 'Zorunlu bir alan boş bırakılmış', warn: true };
    // Serileştirme hatası / kilitlenme: işlem geri alındı, aynı istek yeniden denenebilir.
    if (pg.code === '40001' || pg.code === '40P01') return { status: 409, code: 'RETRY', message: 'Eşzamanlı işlem çakışması; lütfen tekrar deneyin' };
    const data = dataException(pg.code);
    if (data) return data;
    // Sorgu zaman aşımı (statement_timeout) ya da kilit beklemesi
    if (pg.code === '57014' || pg.code === '55P03') {
      return { status: 503, code: 'TIMEOUT', message: 'İşlem zaman aşımına uğradı; birkaç saniye sonra tekrar deneyin', headers: { 'retry-after': '5' }, warn: true };
    }
    // Bağlantı sorunları: sınıf 08, sunucu kapanıyor/başlıyor (57P01–57P03), çok fazla bağlantı (53300)
    if (pg.code.startsWith('08') || pg.code === '57P01' || pg.code === '57P02' || pg.code === '57P03' || pg.code === '53300') return BUSY;
  }

  // Bağlantı havuzu tükendi (pg-pool: "timeout exceeded when trying to connect") ya da veritabanına ulaşılamıyor (API-3)
  if (
    someInChain(err, (e) => {
      const m = typeof e.message === 'string' ? e.message : '';
      return (
        /timeout exceeded when trying to connect|Connection terminated|connection timeout|Client has encountered a connection error/i.test(m) ||
        (typeof e.code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE'].includes(e.code))
      );
    })
  ) {
    return BUSY;
  }

  // Doğrulamadan kaçan bir Decimal dönüşümü (ör. servis içinde) 500 değil 400 olsun (API-2)
  if (someInChain(err, (e) => typeof e.message === 'string' && e.message.startsWith('[DecimalError]'))) {
    return { status: 400, code: 'INVALID_NUMBER', message: 'Geçersiz sayı', warn: true };
  }

  const f = err as FastifyError;
  if (f && f.statusCode === 429) return { status: 429, code: 'RATE_LIMITED', message: 'Çok fazla istek; lütfen biraz sonra tekrar deneyin' };
  if (f && typeof f.statusCode === 'number' && f.statusCode >= 400 && f.statusCode < 500) {
    const code = f.code ?? 'BAD_REQUEST';
    const byStatus: Record<number, string> = { 401: 'Oturum geçersiz veya süresi dolmuş', 404: 'Bulunamadı', 405: 'Bu yöntem desteklenmiyor', 413: 'İstek gövdesi çok büyük', 415: 'Desteklenmeyen içerik türü' };
    return { status: f.statusCode, code, message: FASTIFY_MESSAGES[code] ?? byStatus[f.statusCode] ?? 'Geçersiz istek' };
  }
  return null;
}

/** Toplu işlemlerde tek kalemin hatasını raporlamak için: uygulama hatası, veritabanı kuralı ya da beklenmeyen hata. */
export function describeError(err: unknown): { code: string; message: string } {
  const m = mapError(err);
  return m ? { code: m.code, message: m.message } : { code: 'ERROR', message: 'Beklenmeyen hata' };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  const m = mapError(err);
  if (m) {
    if (m.warn) req.log.warn({ err }, m.code);
    if (m.headers) for (const [k, v] of Object.entries(m.headers)) void reply.header(k, v);
    void reply.status(m.status).send({ error: { code: m.code, message: m.message, ...(m.details !== undefined ? { details: m.details } : {}) } });
    return;
  }
  req.log.error({ err }, 'beklenmeyen hata');
  void reply.status(500).send({ error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu' } });
}
