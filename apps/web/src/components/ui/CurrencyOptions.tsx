import { CURRENCY_CODES, currencySymbol, type CurrencyCode } from '@erp/shared';
import { useTranslation } from 'react-i18next';

/** "₺ Türk lirası" (geniş) ya da "₺" (dar). */
export function useCurrencyLabel() {
  const { t } = useTranslation();
  return (code: string, wide = false): string => {
    if (!wide || !(CURRENCY_CODES as readonly string[]).includes(code)) return currencySymbol(code);
    return `${currencySymbol(code)} ${t(`currencies.names.${code as CurrencyCode}`)}`;
  };
}

/**
 * Para birimi seçeneklerinin tek kaynağı: etiket simge, `value` daima kod (TRY, GBP …).
 * Dar satır içi seçicilerde yalnızca simge; geniş form seçicilerinde simge + ad (`wide`).
 */
export function CurrencyOptions({ wide = false }: { wide?: boolean }) {
  const label = useCurrencyLabel();
  return (
    <>
      {CURRENCY_CODES.map((c) => (
        <option key={c} value={c}>
          {label(c, wide)}
        </option>
      ))}
    </>
  );
}
