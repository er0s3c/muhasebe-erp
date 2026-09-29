import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { DeliveryInvoicing, DeliveryNoteStatus } from '../../lib/types';
import { STOCK_INVALIDATE } from '../inventory/common';

/** İrsaliye değişince etkilenen sorgular: irsaliye listeleri/özet ve stok (kart, rapor, hareket, mutabakat). */
export const DELIVERY_INVALIDATE = [['delivery-notes'], ['delivery-note'], ['delivery-open-lines'], ['delivery-summary'], ...STOCK_INVALIDATE, ['dashboard']];

const STATUS_TONE = { draft: 'warning', posted: 'success', cancelled: 'danger' } as const;
const INVOICING_TONE = { open: 'warning', partial: 'brand', invoiced: 'success' } as const;

export function DeliveryStatusBadge({ status }: { status: DeliveryNoteStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`deliveries.status.${status}`)}</Badge>;
}

export function DeliveryInvoicingBadge({ state }: { state: DeliveryInvoicing | null }) {
  const { t } = useTranslation();
  if (!state) return null;
  return <Badge tone={INVOICING_TONE[state]}>{t(`deliveries.invoicing.${state}`)}</Badge>;
}
