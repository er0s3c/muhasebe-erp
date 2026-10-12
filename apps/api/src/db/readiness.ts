import { setTimeout as sleep } from 'node:timers/promises';

const temporaryCodes = new Set(['57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
export function temporaryDatabaseError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof value.code === 'string' && temporaryCodes.has(value.code)) return true;
    if (value.errors?.length && value.errors.every(temporaryDatabaseError)) return true;
    current = value.cause;
  }
  return false;
}

/** Yalnız geçici açılış/bağlantı hataları yeniden denenir; yanlış parola ve şema hatası bekletilmez. */
export async function withDatabaseReadiness<T>(check: () => Promise<T>, options: {
  attempts?: number; delayMs?: number; wait?: (milliseconds: number) => Promise<unknown>; onRetry?: (attempt: number) => void;
} = {}): Promise<T> {
  const attempts = options.attempts ?? 20;
  for (let attempt = 1; ; attempt++) {
    try { return await check(); }
    catch (error) {
      if (attempt >= attempts || !temporaryDatabaseError(error)) throw error;
      options.onRetry?.(attempt);
      await (options.wait ?? sleep)(options.delayMs ?? 1000);
    }
  }
}
