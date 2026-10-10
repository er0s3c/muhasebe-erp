import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTR, parseTR } from '@erp/shared';
import { cn } from '../../lib/cn';
import { Input } from './Field';

interface MoneyInputProps {
  /** Kanonik ondalık string ("1234.5") ya da boş. */
  value: string;
  onChange: (canonical: string) => void;
  /** Gösterilecek en az ondalık basamak. */
  decimals?: number;
  /** Değer daha hassassa, buraya kadar basamak gösterilir (kur gibi alanlar için). */
  maxDecimals?: number;
  /** false: eksi işareti geçersiz sayılır (tutar, miktar, oran alanlarının çoğu). Varsayılan true. */
  allowNegative?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  id?: string;
}

/** Kanonik değerin anlamlı ondalık basamağı ("12.5000" -> 1). */
const decimalsOf = (canonical: string) => canonical.split('.')[1]?.replace(/0+$/, '').length ?? 0;
const isCanonical = (v: string) => /^-?\d+(\.\d+)?$/.test(v);

/**
 * Türkçe biçimli sayı girişi (tutar, miktar, fiyat, oran): yazarken serbest, odaktan çıkınca 1.234,56 olarak biçimlenir.
 * Dışarıya her zaman kanonik ("1234.56") değer verir; gösterim asla değeri yuvarlayıp gizlemez.
 *
 * Ayrıştırma `parseTR` kuralıdır: "250.000" → 250000, "1.234,56" → 1234.56, "12,5" → 12.5, "12.5" → 12.5 (UI-1/UI-2).
 * Geçersiz yazımda (UI-3) değer sessizce silinmez: yazılan metin alanda kalır, alan kırmızı çerçeve ve "Geçersiz sayı"
 * iletisiyle işaretlenir (aria-invalid) ve dışarıya boş değer verilir (zorunlu alan kaydı engellenir).
 */
export function MoneyInput({ value, onChange, decimals = 2, maxDecimals = decimals, allowNegative = true, className, 'aria-describedby': describedBy, 'aria-invalid': fieldInvalid, ...rest }: MoneyInputProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** Bu bileşenin en son dışarı verdiği değer: farklı bir değer gelirse dışarıdan değiştirilmiştir. */
  const emitted = useRef(value);
  const valid = value === '' || isCanonical(value);
  const dp = Math.min(Math.max(valid ? decimalsOf(value) : 0, decimals), Math.max(maxDecimals, decimals));
  const shown = draft ?? (value === '' ? '' : valid ? formatTR(value, dp) : value);
  const parsed = draft === null || draft.trim() === '' ? null : parseTR(draft);
  const invalid = draft !== null && draft.trim() !== '' && (parsed === null || (!allowNegative && parsed.startsWith('-')));

  useEffect(() => {
    // Değer dışarıdan değiştirilirse (form temizlendi, fiyat önerildi) odakta değilken taslağı bırak
    if (draft !== null && !focused && value !== emitted.current) setDraft(null);
    emitted.current = value;
  }, [value, draft, focused]);

  return (
    <>
      <Input
        inputMode="decimal"
        autoComplete="off"
        className={cn('num', invalid && 'border-danger focus:border-danger', className)}
        value={shown}
        aria-invalid={invalid || fieldInvalid || undefined}
        aria-describedby={[describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined}
        title={invalid ? t('common.invalidNumber') : undefined}
        onFocus={(e) => {
          setFocused(true);
          if (draft === null) setDraft(value === '' || !valid ? value : formatTR(value, dp).replace(/\.(?=\d{3}(\D|$))/g, ''));
          const el = e.target;
          requestAnimationFrame(() => {
            if (document.activeElement === el) el.select();
          });
        }}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const p = text.trim() === '' ? null : parseTR(text);
          const next = p !== null && (allowNegative || !p.startsWith('-')) ? p : '';
          emitted.current = next;
          onChange(next);
        }}
        onBlur={() => {
          setFocused(false);
          // Geçerliyse biçimli gösterime dön; geçersizse kullanıcının yazdığı kalır (silinmez)
          if (!invalid) setDraft(null);
        }}
        {...rest}
      />
      {invalid && (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-danger">
          {t('common.invalidNumber')}
        </span>
      )}
    </>
  );
}
