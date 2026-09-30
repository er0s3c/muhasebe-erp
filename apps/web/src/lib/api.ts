/**
 * API istemcisi. Erişim jetonu yalnızca bellekte tutulur (XSS ile çalınamaz);
 * oturum, httpOnly refresh çerezi ile sayfa yenilenince geri kurulur.
 */
export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Doğrulama hatasında alan bazlı mesajları döndürür. */
  get fieldErrors(): ApiErrorDetail[] {
    return this.code === 'VALIDATION_ERROR' && Array.isArray(this.details)
      ? (this.details as ApiErrorDetail[])
      : [];
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (fn: (() => void) | null) => {
  onSessionLost = fn;
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  companyId?: string | null;
  signal?: AbortSignal;
}

async function raw(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.companyId) headers['X-Company-Id'] = opts.companyId;
  return fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
}

/** Aynı anda birden çok istek 401 alırsa tek bir yenileme yapılır. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      // Başka bir sekme aynı çerezle aynı anda yenilediyse sunucu 409 döner; çerez artık güncel olduğundan bir kez daha denenir.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (res.status === 409 && attempt === 0) {
          void res.body?.cancel(); // okunmayan gövde bağlantıyı (ve `no-store` yanıtlarda isteği) açık tutar
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (!res.ok) {
          void res.body?.cancel();
          return false;
        }
        const data = (await res.json()) as { accessToken: string };
        accessToken = data.accessToken;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
  try {
    body = await res.json();
  } catch {
    /* gövde yok */
  }
  return new ApiError(
    res.status,
    body.error?.code ?? 'UNKNOWN',
    body.error?.message ?? `İstek başarısız (${res.status})`,
    body.error?.details,
  );
}

/** İsteği gönderir; 401 alırsa oturumu bir kez yeniler ve yeniden dener. */
async function send(path: string, opts: RequestOptions): Promise<Response> {
  let res = await raw(path, opts);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) {
      res = await raw(path, opts);
    } else {
      accessToken = null;
      onSessionLost?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await (await send(path, opts)).json()) as T;
}

/** Dosya indirme: kimlikli istek (jeton bellekte olduğundan düz bağlantı çalışmaz); dosya adı yanıt başlığından. */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await send(path, opts);
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? null;
  return { blob: await res.blob(), filename: name };
}
