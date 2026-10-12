import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCQuery } from '../../lib/queries';
import type { InvoiceableOrderLine } from '../../lib/types';
import { qtyText } from '../inventory/common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  currency: string;
  /** Formda bu sipariş satırlarından zaten kullanılan miktar (satır kimliği -> miktar) */
  taken: Map<string, string>;
  /** Seçilenler, önerilen miktarla (kabul − faturalanan; yoksa sipariş − faturalanan) döner */
  onAdd: (lines: (InvoiceableOrderLine & { suggested: string })[]) => void;
}

/** Alış faturasına sipariş satırı bağlamak için: cariye ve para birimine ait, faturalanmamış kalanı olan sipariş satırları. */
export function OrderLinePicker({ open, onOpenChange, partyId, currency, taken, onAdd }: Props) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data, isPending, error: OrderLinePickerQueryError, refetch: OrderLinePickerQueryRetry, isFetching: OrderLinePickerQueryFetching } = useCQuery<{ lines: InvoiceableOrderLine[] }>(
    ['procurement', 'invoiceable', partyId, currency],
    `/api/procurement/invoiceable?partyId=${partyId}&currency=${currency}`,
    { enabled: open && !!partyId },
  );
  const rows = (data?.lines ?? [])
    .map((l) => {
      const used = dec(l.invoicedQty).plus(taken.get(l.lineId) ?? 0);
      const receivedLeft = dec(l.receivedQty).minus(used);
      const orderedLeft = dec(l.orderedQty).minus(used);
      return { ...l, suggested: (receivedLeft.gt(0) ? receivedLeft : orderedLeft).toFixed(4), orderedLeft };
    })
    .filter((l) => l.orderedLeft.gt(0));
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const close = () => {
    setPicked(new Set());
    onOpenChange(false);
  };
  
  return (
    <Sheet
      wide
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={t('procurement.match.pickerTitle')}
      description={t('procurement.match.pickerDesc')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={picked.size === 0}
            onClick={() => {
              onAdd(rows.filter((r) => picked.has(r.lineId)));
              close();
            }}
          >
            {t('procurement.match.pickerAdd')}
          </Button>
        </>
      }
    >
      {!partyId ? (
        <Callout>{t('procurement.match.pickPartyFirst')}</Callout>
      ) : OrderLinePickerQueryError && !data ? <ErrorState error={OrderLinePickerQueryError} onRetry={() => void OrderLinePickerQueryRetry()} retrying={OrderLinePickerQueryFetching} /> : isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Callout>{t('procurement.match.pickerEmpty')}</Callout>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-10" />
                <Th>{t('procurement.match.cols.order')}</Th>
                <Th>{t('procurement.match.cols.line')}</Th>
                <Th num>{t('procurement.match.cols.ordered')}</Th>
                <Th num>{t('procurement.match.cols.received')}</Th>
                <Th num>{t('procurement.match.cols.invoiced')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.lineId} clickable onClick={() => toggle(r.lineId)}>
                  <Td>
                    <input type="checkbox" className="size-4" checked={picked.has(r.lineId)} onChange={() => toggle(r.lineId)} onClick={(e) => e.stopPropagation()} aria-label={`${r.orderCode} · ${r.description}`} />
                  </Td>
                  <Td className="font-mono text-[13px]">{r.orderCode}</Td>
                  <Td>{r.description}</Td>
                  <Td num>{qtyText(r.orderedQty)}</Td>
                  <Td num>{qtyText(r.receivedQty)}</Td>
                  <Td num>{qtyText(r.invoicedQty)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Sheet>
  );
}
