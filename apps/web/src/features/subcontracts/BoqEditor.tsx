import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { dec, roundMoney } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, EmptyState } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { money, moneyIn } from '../../lib/format';
import type { SubcontractRevisionDetail } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { useCostCodes } from './common';
import { MoneyInput } from '../../components/ui/MoneyInput';

interface Draft {
  key: string;
  lineKey?: string;
  itemNo: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  wbsId: string;
  costCodeId: string;
}

const blank = (): Draft => ({ key: crypto.randomUUID(), itemNo: '', description: '', unit: 'adet', quantity: '', unitPrice: '', wbsId: '', costCodeId: '' });
export type BoqBody = ReturnType<typeof toBody>;
export const toBody = (lines: Draft[]) =>
  lines.map((l) => ({
    ...(l.lineKey ? { lineKey: l.lineKey } : {}),
    ...(l.itemNo.trim() ? { itemNo: l.itemNo.trim() } : {}),
    description: l.description.trim(),
    unit: l.unit.trim(),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    wbsId: l.wbsId,
    costCodeId: l.costCodeId || null,
  }));
const lineTotal = (l: Draft) => (l.quantity && l.unitPrice ? roundMoney(dec(l.quantity).times(l.unitPrice)) : dec(0));

/**
 * Revizyon BOQ tablosu: taslakta düzenlenir, onaylıda salt okunur. Kaydetme/onay düğmeleri çağıranın `footer`'ındadır
 * (sözleşme BOQ sekmesi ve değişiklik emri sayfası aynı editörü kullanır).
 */
export function BoqEditor({
  data,
  projectId,
  currencyCode,
  editable,
  title,
  description,
  footer,
}: {
  data: SubcontractRevisionDetail;
  projectId: string;
  currencyCode: string;
  editable: boolean;
  title: string;
  description?: string;
  footer?: (state: { body: BoqBody; valid: boolean }) => ReactNode;
}) {
  const { t } = useTranslation();
  const { byId } = useProjectOptions();
  const wbsOptions = useMemo(() => (byId.get(projectId)?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}`, keywords: `${w.code} ${w.name}` })), [byId, projectId]);
  const costCodes = useCostCodes();
  const sc = { projectId, currencyCode };

  const [lines, setLines] = useState<Draft[]>([]);
  useEffect(() => {
    setLines(
      data.lines.map((l) => ({ key: l.id, lineKey: l.lineKey, itemNo: l.itemNo ?? '', description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), wbsId: l.wbsId, costCodeId: l.costCodeId ?? '' })),
    );
  }, [data]);

  const patch = (key: string, p: Partial<Draft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const valid = lines.length > 0 && lines.every((l) => l.description.trim() && l.unit.trim() && dec(l.quantity || 0).gt(0) && l.unitPrice !== '' && l.wbsId);
  const total = lines.reduce((s, l) => s.plus(lineTotal(l)), dec(0));

  return (
    <>
      {wbsOptions.length === 0 && editable && <Callout tone="warning">{t('subcontracts.boq.noWbs')}</Callout>}
      <Card>
          <CardHeader
            title={title}
            description={description}
            action={editable ? (
              <Button onClick={() => setLines((ls) => [...ls, blank()])}>
                <Plus className="size-4" aria-hidden />
                {t('subcontracts.boq.addLine')}
              </Button>
            ) : undefined}
          />
          {lines.length === 0 ? (
            <EmptyState title={t('subcontracts.boq.empty')} description={editable ? t('subcontracts.boq.emptyDesc') : undefined} />
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th className="w-20">{t('subcontracts.boq.cols.itemNo')}</Th>
                    <Th>{t('subcontracts.boq.cols.description')}</Th>
                    <Th className="w-24">{t('subcontracts.boq.cols.unit')}</Th>
                    <Th num className="w-32">{t('subcontracts.boq.cols.quantity')}</Th>
                    <Th num className="w-32">{t('subcontracts.boq.cols.unitPrice')}</Th>
                    <Th num className="w-36">{t('subcontracts.boq.cols.amount')}</Th>
                    <Th className="w-56">{t('subcontracts.boq.cols.wbs')}</Th>
                    <Th className="w-36">{t('subcontracts.boq.cols.costCode')}</Th>
                    {editable && <Th className="w-10"><span className="sr-only">{t('common.delete')}</span></Th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const wbs = byId.get(sc.projectId)?.wbs.find((w) => w.id === l.wbsId);
                    const code = costCodes.find((c) => c.id === l.costCodeId);
                    return (
                      <Tr key={l.key}>
                        {editable ? (
                          <>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.itemNo')} ${i + 1}`} value={l.itemNo} onChange={(e) => patch(l.key, { itemNo: e.target.value })} maxLength={40} /></Td>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.description')} ${i + 1}`} value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} maxLength={300} /></Td>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.unit')} ${i + 1}`} value={l.unit} onChange={(e) => patch(l.key, { unit: e.target.value })} maxLength={20} /></Td>
                            <Td num><MoneyInput aria-label={`${t('subcontracts.boq.cols.quantity')} ${i + 1}`} className="text-right" value={l.quantity} onChange={(v) => patch(l.key, { quantity: v })} decimals={0} maxDecimals={4} /></Td>
                            <Td num><MoneyInput aria-label={`${t('subcontracts.boq.cols.unitPrice')} ${i + 1}`} className="text-right" value={l.unitPrice} onChange={(v) => patch(l.key, { unitPrice: v })} maxDecimals={6} /></Td>
                            <Td num>{money(lineTotal(l).toFixed(2))}</Td>
                            <Td><Combobox aria-label={`${t('subcontracts.boq.cols.wbs')} ${i + 1}`} options={wbsOptions} value={l.wbsId || null} onChange={(v) => patch(l.key, { wbsId: v })} placeholder={t('subcontracts.boq.pickWbs')} /></Td>
                            <Td>
                              <Select aria-label={`${t('subcontracts.boq.cols.costCode')} ${i + 1}`} value={l.costCodeId} onChange={(e) => patch(l.key, { costCodeId: e.target.value })}>
                                <option value="">{t('subcontracts.boq.defaultCode')}</option>
                                {costCodes.filter((c) => c.isActive).map((c) => (
                                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                ))}
                              </Select>
                            </Td>
                            <Td>
                              <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                                <Trash2 className="size-4" aria-hidden />
                              </button>
                            </Td>
                          </>
                        ) : (
                          <>
                            <Td className="font-mono text-[13px] text-muted">{l.itemNo}</Td>
                            <Td>{l.description}</Td>
                            <Td className="text-muted">{l.unit}</Td>
                            <Td num>{money(l.quantity, 4).replace(/,?0+$/, '')}</Td>
                            <Td num>{money(l.unitPrice)}</Td>
                            <Td num>{money(lineTotal(l).toFixed(2))}</Td>
                            <Td className="text-muted">{wbs ? `${wbs.code} — ${wbs.name}` : '—'}</Td>
                            <Td className="text-muted">{code?.code ?? t('subcontracts.boq.defaultCode')}</Td>
                          </>
                        )}
                      </Tr>
                    );
                  })}
                  <Tr className="border-t border-text bg-surface-2">
                    <Td colSpan={5}>{t('common.total')}</Td>
                    <Td num>{moneyIn(total.toFixed(2), sc.currencyCode)}</Td>
                    <Td colSpan={editable ? 3 : 2} />
                  </Tr>
                </tbody>
              </Table>
            </TableWrap>
          )}
          {footer?.({ body: toBody(lines), valid })}
      </Card>
    </>
  );
}
