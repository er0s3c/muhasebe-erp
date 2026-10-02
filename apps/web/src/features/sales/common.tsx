import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { Fulfilment, FulfilmentState, SalesDocKind, SalesDocStatus } from '../../lib/types';
import { DELIVERY_INVALIDATE } from '../deliveries/common';

/** Teklif/sipariş değişince etkilenen sorgular: liste, ayrıntı, irsaliye ve fatura (karşılanma oradan türer). */
export const SALES_INVALIDATE = [['sales-docs'], ['sales-doc'], ...DELIVERY_INVALIDATE, ['invoices'], ['invoice'], ['journal']];

const STATUS_TONE: Record<SalesDocStatus, 'neutral' | 'warning' | 'success' | 'danger' | 'brand'> = {
  draft: 'warning',
  sent: 'brand',
  accepted: 'success',
  rejected: 'danger',
  converted: 'success',
  confirmed: 'brand',
  closed: 'neutral',
  cancelled: 'danger',
};

export function SalesStatusBadge({ status, kind, expired }: { status: SalesDocStatus; kind: SalesDocKind; expired?: boolean }) {
  const { t } = useTranslation();
  if (expired) return <Badge tone="danger">{t('sales.status.expired')}</Badge>;
  return <Badge tone={STATUS_TONE[status]}>{t(`sales.status.${kind}.${status}` as never)}</Badge>;
}

const FULFIL_TONE: Record<FulfilmentState, 'neutral' | 'warning' | 'success'> = { none: 'neutral', partial: 'warning', full: 'success' };

/** Siparişin türetilmiş teslim ve fatura durumu (stored durum değildir). */
export function FulfilmentBadges({ f }: { f: Fulfilment | null }) {
  const { t } = useTranslation();
  if (!f) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {f.delivery && <Badge tone={FULFIL_TONE[f.delivery]}>{t('sales.fulfil.delivery', { state: t(`sales.fulfil.state.${f.delivery}`) })}</Badge>}
      <Badge tone={FULFIL_TONE[f.invoicing]}>{t('sales.fulfil.invoicing', { state: t(`sales.fulfil.state.${f.invoicing}`) })}</Badge>
    </span>
  );
}
