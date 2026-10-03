import i18n from '../i18n';
import { ApiError } from './api';

/** Ayrıntılı (Türkçe) sunucu mesajının genel çeviriden daha yararlı olduğu kodlar. */
const SERVER_MESSAGE_CODES = new Set(['DUPLICATE', 'LEDGER_RULE_VIOLATION', 'TREASURY_RULE_VIOLATION', 'PROJECT_RULE_VIOLATION', 'MODULE_REQUIRED_BY', 'MODULE_MISSING_REQUIREMENT', 'CONSOLIDATION_RULE_VIOLATION', 'GROUP_MEMBER_DENIED', 'GROUP_NO_ACCESS', 'GROUP_MEMBER_ACCESS_LOST', 'FX_RATE_MISSING', 'FISCAL_YEAR_RULE_VIOLATION', 'YEAR_END_BLOCKED', 'REOPEN_PERIOD_CLOSED', 'FISCAL_YEAR_ORDER', 'CONFIRMATION_MISMATCH']);
/**
 * Lisans ve cihaz hataları: sunucu mesajı (Türkçe) sayıyı, nedeni ve yönlendirmeyi içerir ("en fazla 3 cihaz", "süreniz doldu" …);
 * satıcı sunucusundan iletilen hatalar da (INVALID_CODE, ACTIVATION_LIMIT …) satıcının kendi açıklamasıyla gösterilir.
 */
const SERVER_MESSAGE_PREFIXES = ['LICENSE_', 'DEVICE_'];
const SERVER_MESSAGE_LICENSE_CODES = new Set(['INVALID_CODE', 'ACTIVATION_LIMIT', 'INSTALLATION_IN_USE', 'INSTALLATION_KEY_MISMATCH', 'CLOCK_SKEW', 'NOT_ACTIVATED', 'NO_PENDING_REQUEST', 'OWNER_ONLY', 'FINGERPRINT_CHANGED', 'UNKNOWN_INSTALLATION', 'DEACTIVATED', 'REPLAY']);
const fromServer = (code: string) => SERVER_MESSAGE_CODES.has(code) || SERVER_MESSAGE_LICENSE_CODES.has(code) || SERVER_MESSAGE_PREFIXES.some((p) => code.startsWith(p));

/** Hata koduna göre çevrilmiş mesaj; çeviri yoksa sunucu mesajı. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code}`;
    if (i18n.exists(key) && !fromServer(err.code)) return i18n.t(key as never);
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
