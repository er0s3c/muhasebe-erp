import type { Envelope } from '@erp/license-core';

/** Lisans sunucusu hata yanıtı verdi (4xx/5xx; `code` satıcının hata kodudur). */
export class LicenseServerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LicenseServerError';
  }
}

/** Lisans sunucusuna ulaşılamadı (ağ, zaman aşımı, TLS, geçersiz yanıt). */
export class LicenseUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseUnreachableError';
  }
}

/** Satıcı sunucusuyla konuşan taşıma katmanı. Testler bellek içi bir uygulamasını enjekte eder. */
export interface LicenseTransport {
  activate(body: Envelope & { pub: string }): Promise<{ lease: string }>;
  /** `update`: satıcı bu kuruluma bir sürüm gönderdiyse güncelleme teklifi (doğrulanmamış ham veri). */
  heartbeat(envelope: Envelope): Promise<{ lease: string; update?: unknown }>;
  deactivate(envelope: Envelope): Promise<{ ok: true }>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/** HTTPS taşıması: sertifika doğrulaması açık, yönlendirme yok, 10 sn zaman aşımı, yanıt boyutu sınırlı. */
export function httpTransport(baseUrl: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): LicenseTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const base = baseUrl.replace(/\/+$/, '');

  async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new LicenseUnreachableError(`Lisans sunucusuna ulaşılamadı (${reason})`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new LicenseUnreachableError('Lisans sunucusunun yanıtı okunamadı');
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new LicenseUnreachableError('Lisans sunucusunun yanıtı beklenenden büyük');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof e?.code === 'string' ? e.code : 'SERVER_ERROR';
      const message = typeof e?.message === 'string' ? e.message : `Lisans sunucusu hata döndürdü (${res.status})`;
      if (res.status >= 500) throw new LicenseUnreachableError(`Lisans sunucusu geçici olarak hizmet vermiyor (${res.status})`);
      throw new LicenseServerError(res.status, code, message);
    }
    if (json === null || typeof json !== 'object') throw new LicenseUnreachableError('Lisans sunucusunun yanıtı geçersiz');
    return json as T;
  }

  const leaseOf = (r: { lease?: unknown }): { lease: string } => {
    if (typeof r.lease !== 'string') throw new LicenseUnreachableError('Lisans sunucusunun yanıtı geçersiz');
    return { lease: r.lease };
  };

  return {
    activate: async (body) => leaseOf(await post('/v1/activate', body)),
    heartbeat: async (envelope) => {
      const r = await post<{ lease?: unknown; update?: unknown }>('/v1/heartbeat', envelope);
      return { ...leaseOf(r), ...(r.update !== undefined ? { update: r.update } : {}) };
    },
    deactivate: async (envelope) => {
      await post('/v1/deactivate', envelope);
      return { ok: true };
    },
  };
}
