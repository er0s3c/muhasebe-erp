import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { DeliveryNoteType, OpenDeliveryLine } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: DeliveryNoteType;
  partyId: string;
  /** Formda bu irsaliye satırlarından zaten kullanılan miktar (satır kimliği -> miktar) */
  taken: Map<string, string>;
  /** Seçilenler, formda kullanılmamış kalan miktarla birlikte döner */
  onAdd: (lines: (OpenDeliveryLine & { available: string })[]) => void;
}

/** Faturaya irsaliye satırı eklemek için: cariye ait, kalan miktarı olan irsaliye satırlarının seçici penceresi. */
export function DeliveryPicker({ open, onOpenChange, type, partyId, taken, onAdd }: Props) {
  const { t } = useTranslation();
  const unitLabel = useUnitLabel();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data, isPending } = useCQuery<{ lines: OpenDeliveryLine[] }>(
    ['delivery-open-lines', type, partyId],
    `/api/delivery-notes/open-lines?type=${type}&partyId=${partyId}`,
    { enabled: open && !!partyId },
  );

  const rows = (data?.lines ?? [])
    .map((l) => ({ ...l, available: dec(l.remainingQty).minus(taken.get(l.lineId) ?? 0) }))
    .filter((l) => l.available.gt(0));

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
      title={t('deliveries.picker.title')}
      description={t('deliveries.picker.desc')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={picked.size === 0}
            onClick={() => {
              onAdd(rows.filter((r) => picked.has(r.lineId)).map((r) => ({ ...r, available: r.available.toFixed(4) })));
              close();
            }}
          >
            {t('deliveries.picker.add')}
          </Button>
        </>
      }
    >
      {!partyId ? (
        <Callout>{t('deliveries.picker.pickPartyFirst')}</Callout>
      ) : isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Callout>{t('deliveries.picker.empty')}</Callout>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-10" />
                <Th>{t('deliveries.picker.note')}</Th>
                <Th>{t('deliveries.picker.item')}</Th>
                <Th num>{t('deliveries.picker.remaining')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.lineId} clickable onClick={() => toggle(r.lineId)}>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={picked.has(r.lineId)}
                      onChange={() => toggle(r.lineId)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${r.noteNo} · ${r.description}`}
                    />
                  </Td>
                  <Td>
                    <span className="whitespace-nowrap font-mono text-[13px]">{r.noteNo}</span>
                    <span className="block text-xs text-muted">{formatDateTR(r.noteDate)}</span>
                  </Td>
                  <Td>
                    <span>{r.description}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{r.itemCode}</span>
                  </Td>
                  <Td num>
                    {qtyText(r.available.toFixed(4))} {r.unit ? unitLabel(r.unit) : ''}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Sheet>
  );
}
