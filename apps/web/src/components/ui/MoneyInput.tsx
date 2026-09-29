import { useEffect, useState } from 'react';
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
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  id?: string;
}

const decimalsOf = (canonical: string) => canonical.split('.')[1]?.length ?? 0;

/**
 * Türkçe biçimli tutar girişi: yazarken serbest, odaktan çıkınca 1.234,56 olarak biçimlenir.
 * Dışarıya her zaman kanonik ("1234.56") değer verir; gösterim asla değeri yuvarlayıp gizlemez.
 */
export function MoneyInput({ value, onChange, decimals = 2, maxDecimals = decimals, className, ...rest }: MoneyInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const dp = Math.min(Math.max(decimalsOf(value), decimals), Math.max(maxDecimals, decimals));
  const shown = draft ?? (value === '' ? '' : formatTR(value, dp));

  useEffect(() => {
    if (draft === null) return;
    // Dışarıdan değer sıfırlanırsa (örn. form temizlendi) taslağı bırak
    if (value === '') setDraft(null);
  }, [value, draft]);

  return (
    <Input
      inputMode="decimal"
      autoComplete="off"
      className={cn('num', className)}
      value={shown}
      onFocus={(e) => {
        setDraft(value === '' ? '' : formatTR(value, dp).replace(/\.(?=\d{3}(\D|$))/g, ''));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseTR(e.target.value);
        onChange(parsed ?? '');
      }}
      onBlur={() => setDraft(null)}
      {...rest}
    />
  );
}
