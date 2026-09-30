import i18n from '../i18n';
import { ApiError } from './api';

/** Ayrıntılı (Türkçe) sunucu mesajının genel çeviriden daha yararlı olduğu kodlar. */
const SERVER_MESSAGE_CODES = new Set(['LEDGER_RULE_VIOLATION', 'TREASURY_RULE_VIOLATION', 'MODULE_REQUIRED_BY', 'MODULE_MISSING_REQUIREMENT']);

/** Hata koduna göre çevrilmiş mesaj; çeviri yoksa sunucu mesajı. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code}`;
    if (i18n.exists(key) && !SERVER_MESSAGE_CODES.has(err.code)) return i18n.t(key as never);
    return err.message;
  }
  if (err instanceof TypeError) return i18n.t('errors.NETWORK');
  return err instanceof Error ? err.message : i18n.t('errors.INTERNAL');
}

/** Alan adı -> mesaj (sunucu doğrulama hataları için) */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError) {
    for (const d of err.fieldErrors) out[d.path] = d.message;
  }
  return out;
}
