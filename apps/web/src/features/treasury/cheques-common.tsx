import { useTranslation } from 'react-i18next';
import { dec, roundMoney, type ChequeDirection, type ChequeStatus, type MoneyValue } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Field, Input } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Button } from '../../components/ui/Button';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { OpenItem, OpenItemsData } from '../../lib/types';
import { TREASURY_INVALIDATE } from './common';

/** Çek/senet değişince etkilenen sorgular: portföy, kasa/banka, cari, yevmiye, nakit projeksiyonu ve raporlar. */
export const CHEQUE_INVALIDATE = [['cheques'], ['cash-forecast'], ...TREASURY_INVALIDATE];

const TONE: Record<ChequeStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'brand'> = {
  portfolio: 'brand',
  in_collection: 'warning',
  collected: 'success',
  bounced: 'danger',
  endorsed: 'neutral',
  returned: 'neutral',
  issued: 'brand',
  paid: 'success',
  cancelled: 'neutral',
};

export function ChequeStatusBadge({ status }: { status: ChequeStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`cheques.status.${status}`)}</Badge>;
}

export function DirectionBadge({ direction }: { direction: ChequeDirection }) {
  const { t } = useTranslation();
  return <Badge tone={direction === 'received' ? 'success' : 'warning'}>{t(`cheques.direction.${direction}`)}</Badge>;
}

export function UnverifiedNotice({ children }: { children: string }) {
  return <p className="text-xs text-muted">{children}</p>;
}

/** Seçilen açık kalem: kalem para biriminde kapatılan tutar ve belge para biriminde karşılığı. */
export interface PickedItem {
  amount: string;
  settle: string;
}
export type PickedItems = Record<string, PickedItem>;

const num = (v: string | undefined) => dec(v && v !== '' ? v : 0);

export const pickedTotal = (items: PickedItems) => Object.values(items).reduce((s, i) => s.plus(num(i.settle)), dec(0));
export const pickedPayload = (items: PickedItems) => Object.entries(items).map(([lineId, i]) => ({ lineId, amount: i.amount, settleAmount: i.settle }));
export const pickedProblem = (items: PickedItems, open: OpenItem[]) =>
  Object.entries(items).some(([id, i]) => {
    const it = open.find((o) => o.lineId === id);
    return !it || num(i.amount).lte(0) || num(i.amount).gt(it.remaining) || num(i.settle).lte(0);
  });

/**
 * Cari açık kalem seçici (alınan çek: alacak; verilen çek ve ciro: borç). Defter para birimindeki kalemde karşılık tutara eşittir;
 * dövizli kalemde karşılık (belge tutarı) elle girilir. Kalan tutar avans olur (sunucu kuralı).
 */
export function ItemPicker({
  partyId,
  control,
  date,
  total,
  items,
  onChange,
}: {
  partyId: string;
  control: 'receivable' | 'payable';
  date: string;
  /** Belge(ler)in toplam tutarı: "Dağıt" bu tutarı en eski kalemden başlayarak paylaştırır. */
  total: string;
  items: PickedItems;
  onChange: (items: PickedItems) => void;
}) {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const valid = !!partyId && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const q = useCQuery<OpenItemsData>(['party', partyId, 'open-items', date, control], valid ? `/api/parties/${partyId}/open-items?${new URLSearchParams({ asOf: date, type: control })}` : null);
  const open = q.data?.[control]?.items ?? [];
  const used = pickedTotal(items);
  const rest = num(total).minus(used);

  const toggle = (it: OpenItem) => {
    const { [it.lineId]: was, ...others } = items;
    onChange(was ? others : { ...items, [it.lineId]: { amount: it.remaining, settle: it.currencyCode === base ? it.remaining : '' } });
  };
  const allocate = () => {
    let left: MoneyValue = num(total);
    const next: PickedItems = {};
    for (const it of open) {
      if (it.currencyCode !== base) continue;
      if (left.lte(0)) break;
      const rem = dec(it.remaining);
      const part = left.gte(rem) ? rem : roundMoney(left);
      next[it.lineId] = { amount: part.toFixed(2), settle: part.toFixed(2) };
      left = left.minus(part);
    }
    onChange(next);
  };

  if (!valid) return <p className="text-sm text-muted">{t('cheques.items.pickParty')}</p>;
  if (q.isPending) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  return (
    <div className="flex flex-col gap-2">
      {open.length === 0 ? (
        <p className="text-sm text-muted">{t('cheques.items.none')}</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[13px]">{t('cheques.items.title')}</span>
            <Button size="sm" onClick={allocate} disabled={num(total).lte(0)}>{t('cheques.items.allocate')}</Button>
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {open.map((it) => {
              const st = items[it.lineId];
              return (
                <li key={it.lineId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <input type="checkbox" checked={!!st} onChange={() => toggle(it)} aria-label={`${it.entryNo} ${it.description}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{it.entryNo} · {it.description}</div>
                    <div className="text-xs text-muted">{t('cheques.items.due')} {formatDateTR(it.dueDate)} · {t('cheques.items.remaining')} {moneyIn(it.remaining, it.currencyCode)}</div>
                  </div>
                  {st && (
                    <div className="flex items-end gap-2">
                      <Field label={t('cheques.items.amount')} className="w-32">
                        {(id) => <MoneyInput id={id} value={st.amount} onChange={(v) => onChange({ ...items, [it.lineId]: { amount: v, settle: it.currencyCode === base ? v : st.settle } })} />}
                      </Field>
                      {it.currencyCode !== base && (
                        <Field label={t('cheques.items.settle', { cur: base })} className="w-32">
                          {(id) => <MoneyInput id={id} value={st.settle} onChange={(v) => onChange({ ...items, [it.lineId]: { ...st, settle: v } })} />}
                        </Field>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="text-xs text-muted">
        {t('cheques.items.summary', { used: moneyIn(used.toFixed(2), base), rest: moneyIn(rest.isNegative() ? '0' : rest.toFixed(2), base) })}
        {rest.isNegative() && <span className="ml-1 text-danger">{t('cheques.items.over')}</span>}
      </p>
    </div>
  );
}

/** Basit tarih alanı (ISO). */
export function DateField({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return <Field label={label} required={required}>{(id) => <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>;
}
