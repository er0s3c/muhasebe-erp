import { Trash2, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Input } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import type { PurchaseOrderStatus, PurchaseRequestStatus, RfqStatus } from '../../lib/types';
import { useItemOptions } from '../inventory/common';
import { useProjectOptions } from '../projects/common';
import { MoneyInput } from '../../components/ui/MoneyInput';

/** Talep/teklif/sipariş/mal kabul değişince etkilenen sorgular (taahhüt proje raporunda, mal kabul stokta görünür). */
export const PROCUREMENT_INVALIDATE = [
  ['purchase-requests'],
  ['purchase-request'],
  ['rfqs'],
  ['rfq'],
  ['purchase-orders'],
  ['purchase-order'],
  ['approvals'],
  ['projects'],
  ['project'],
  ['items'],
  ['item'],
  ['stock-docs'],
  ['stock-status'],
  ['inventory-summary'],
  ['journal'],
];

export const REQUEST_STATUSES: readonly PurchaseRequestStatus[] = ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'];
export const ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['draft', 'issued', 'closed', 'cancelled'];

const REQ_TONE = { draft: 'neutral', submitted: 'warning', approved: 'success', rejected: 'danger', ordered: 'brand', cancelled: 'danger' } as const;
const ORD_TONE = { draft: 'neutral', issued: 'success', closed: 'brand', cancelled: 'danger' } as const;
const RFQ_TONE = { open: 'warning', awarded: 'success', cancelled: 'danger' } as const;

export function RequestStatusBadge({ status }: { status: PurchaseRequestStatus }) {
  const { t } = useTranslation();
  return <Badge tone={REQ_TONE[status]}>{t(`procurement.requestStatus.${status}`)}</Badge>;
}
export function OrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const { t } = useTranslation();
  return <Badge tone={ORD_TONE[status]}>{t(`procurement.orderStatus.${status}`)}</Badge>;
}
export function RfqStatusBadge({ status }: { status: RfqStatus }) {
  const { t } = useTranslation();
  return <Badge tone={RFQ_TONE[status]}>{t(`procurement.rfqStatus.${status}`)}</Badge>;
}

export interface LineDraft {
  key: string;
  itemId: string;
  description: string;
  unit: string;
  quantity: string;
  /** Talepte tahmini, siparişte kesin birim fiyat. */
  price: string;
  wbsId: string;
}
export const emptyLine = (): LineDraft => ({ key: crypto.randomUUID(), itemId: '', description: '', unit: 'adet', quantity: '', price: '', wbsId: '' });
/** Alanlar MoneyInput ile kanonik değer ("1234.5") tutar; burada yalnızca boşluk kırpılır. */
export const num = (v: string) => v.trim();
export const lineValid = (l: LineDraft, priceRequired: boolean) =>
  l.description.trim().length > 0 && l.unit.trim().length > 0 && Number(num(l.quantity)) > 0 && (!priceRequired || (l.price.trim() !== '' && Number(num(l.price)) >= 0));

interface EditorProps {
  projectId: string;
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  disabled?: boolean;
  priceLabel: string;
  /** Siparişte iş kalemi zorunlu (verirken); talepte isteğe bağlı. */
  wbsRequired?: boolean;
}

/** Talep ve sipariş satırı düzenleyici: stok kartı seçilirse açıklama/birim kartan gelir. */
export function LinesEditor({ projectId, lines, onChange, disabled, priceLabel, wbsRequired }: EditorProps) {
  const { t } = useTranslation();
  const { byId: projectById } = useProjectOptions();
  const { items, options: itemOptions } = useItemOptions(!disabled);
  const wbsOptions = useMemo(() => (projectById.get(projectId)?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}`, keywords: `${w.code} ${w.name}` })), [projectById, projectId]);
  const set = (key: string, patch: Partial<LineDraft>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key: string, itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    set(key, it ? { itemId, description: it.name, unit: it.unit } : { itemId: '' });
  };
  return (
    <>
      <TableWrap className="rounded-none border-0">
        <Table>
          <thead>
            <tr>
              <Th className="w-8">#</Th>
              <Th className="w-56">{t('procurement.lines.item')}</Th>
              <Th>{t('procurement.lines.description')}</Th>
              <Th className="w-20">{t('procurement.lines.unit')}</Th>
              <Th num className="w-28">{t('procurement.lines.quantity')}</Th>
              <Th num className="w-32">{priceLabel}</Th>
              <Th className="w-56">{wbsRequired ? t('procurement.lines.wbsRequired') : t('procurement.lines.wbs')}</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <Tr key={l.key}>
                <Td className="text-muted">{i + 1}</Td>
                <Td>
                  <Combobox aria-label={`${t('procurement.lines.item')} ${i + 1}`} options={[{ value: '', label: t('procurement.lines.freeLine') }, ...itemOptions]} value={l.itemId} onChange={(v) => pickItem(l.key, v)} placeholder={t('procurement.lines.freeLine')} disabled={disabled} />
                </Td>
                <Td><Input aria-label={`${t('procurement.lines.description')} ${i + 1}`} value={l.description} disabled={disabled} maxLength={300} onChange={(e) => set(l.key, { description: e.target.value })} /></Td>
                <Td><Input aria-label={`${t('procurement.lines.unit')} ${i + 1}`} value={l.unit} disabled={disabled || !!l.itemId} maxLength={20} onChange={(e) => set(l.key, { unit: e.target.value })} /></Td>
                <Td><MoneyInput aria-label={`${t('procurement.lines.quantity')} ${i + 1}`} className="text-right" value={l.quantity} disabled={disabled} onChange={(v) => set(l.key, { quantity: v })} decimals={0} maxDecimals={4} /></Td>
                <Td><MoneyInput aria-label={`${priceLabel} ${i + 1}`} className="text-right" value={l.price} disabled={disabled} onChange={(v) => set(l.key, { price: v })} maxDecimals={6} /></Td>
                <Td>
                  <Combobox aria-label={`${t('procurement.lines.wbs')} ${i + 1}`} options={[{ value: '', label: '—' }, ...wbsOptions]} value={l.wbsId} onChange={(v) => set(l.key, { wbsId: v })} placeholder={t('procurement.lines.wbs')} disabled={disabled || !projectId} />
                </Td>
                <Td>
                  {!disabled && lines.length > 1 && (
                    <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {!disabled && (
        <div className="p-3">
          <Button size="sm" onClick={() => onChange([...lines, emptyLine()])}>
            <Plus className="size-4" aria-hidden />
            {t('procurement.lines.add')}
          </Button>
        </div>
      )}
    </>
  );
}
