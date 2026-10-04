import { MODULES } from '@erp/shared';
import i18n from '../i18n';

/**
 * Modül anahtarı -> çeviri anahtarı. Tek kaynak paylaşılan modül kaydıdır (`MODULES[].labelKey`); web'de ayrı bir
 * eşleme tutulmaz (UI-5/UI-6: elle tutulan eksik eşleme 16 modülü "Genel bakış" diye gösteriyordu).
 */
export const MODULE_LABEL_KEYS: Readonly<Record<string, string>> = Object.fromEntries(MODULES.map((m) => [m.key, m.labelKey]));

/** Modül açıklamasının çeviri anahtarı: `modules.hrPayroll` -> `settings.modules.desc.hrPayroll` (noktasız, iç içe aramaya takılmaz). */
export const moduleDescKey = (key: string): string | null => {
  const label = MODULE_LABEL_KEYS[key];
  return label ? `settings.modules.desc.${label.slice('modules.'.length)}` : null;
};

/** Modülün Türkçe adı; kayıtta yoksa (eski/bilinmeyen anahtar) anahtarın kendisi. */
export function moduleName(key: string): string {
  const label = MODULE_LABEL_KEYS[key];
  return label ? String(i18n.t(label as never)) : key;
}

/** Modülün kısa açıklaması; yoksa boş. */
export function moduleDescription(key: string): string {
  const k = moduleDescKey(key);
  return k && i18n.exists(k) ? String(i18n.t(k as never)) : '';
}
