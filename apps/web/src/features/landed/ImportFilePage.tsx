import { AllocationError, allocateAmount, dec, landedUnitCost, todayIso, type AllocLine, type LandedMethod } from '@erp/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ImportCostKind, ImportFileDetail, ImportMethod, ImportReport, ImportSource } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { qtyText } from '../inventory/common';
import { IMPORT_COST_KINDS, IMPORT_INVALIDATE, IMPORT_METHODS, ImportStatusBadge } from './common';

interface FormLine {
  sourceKind: 'invoice' | 'delivery';
  sourceLineId: string;
  docNo: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: string;
  value: string;
  weight: string;
}

interface FormCost {
  kind: ImportCostKind;
  description: string;
  partyId: string;
  currencyCode: string;
  amount: string;
  fxRate: string;
  method: ImportMethod;
  reference: string;
}

/** /inventory/imports/new ve /inventory/imports/:id: taslakta düzenlenir; dağıtılmış/muhasebeleşmiş dosya salt okunurdur. */
export function ImportFilePage() {
  const { id } = useParams<{ id: string }>();
  const canManage = useCan()('invoices.manage');
  const detail = useCQuery<ImportFileDetail>(['import-file', id], id ? `/api/import-files/${id}` : null);
  if (!id) return canManage ? <Editor key="new" /> : <Callout tone="danger">forbidden</Callout>;
  if (detail.error) return <Callout tone="danger">{errorMessage(detail.error)}</Callout>;
  if (!detail.data) return <PageLoading />;
  return <Editor key={`${id}-${detail.data.events.length}`} detail={detail.data} />;
}

function Editor({ detail }: { detail?: ImportFileDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const { options: partyOptions } = usePartyOptions('supplier');
  const status = detail?.file.status ?? 'draft';
  const editable = status === 'draft' && can('invoices.manage');

  const [name, setName] = useState(detail?.file.name ?? '');
  const [reference, setReference] = useState(detail?.file.reference ?? '');
  const [description, setDescription] = useState(detail?.file.description ?? '');
  const [fileDate, setFileDate] = useState(detail?.file.fileDate ?? todayIso());
  const [method, setMethod] = useState<ImportMethod>(detail?.file.method ?? 'value');
  const [lines, setLines] = useState<FormLine[]>(
    () => detail?.lines.map((l) => ({ sourceKind: l.sourceKind, sourceLineId: l.sourceLineId, docNo: l.sourceDocNo, itemCode: l.itemCode, itemName: l.itemName, unit: l.unit, quantity: l.quantity, value: l.valueBase, weight: l.weight ?? '' })) ?? [],
  );
  const [costs, setCosts] = useState<FormCost[]>(
    () => detail?.costLines.map((c) => ({ kind: c.kind, description: c.description, partyId: c.partyId ?? '', currencyCode: c.currencyCode, amount: c.amount, fxRate: c.fxRate ?? '', method: c.method, reference: c.reference ?? '' })) ?? [],
  );
  const [manual, setManual] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(!detail);
  const [picker, setPicker] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [postDate, setPostDate] = useState(todayIso());
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelDate, setCancelDate] = useState(todayIso());

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  const body = () => ({
    name: name.trim(),
    reference: reference.trim() || null,
    description: description.trim() || null,
    method,
    fileDate,
    lines: lines.map((l) => ({ sourceKind: l.sourceKind, sourceLineId: l.sourceLineId, weight: l.weight || null })),
    costLines: costs.map((c) => ({
      kind: c.kind,
      description: c.description.trim(),
      partyId: c.partyId || null,
      currencyCode: c.currencyCode,
      amount: c.amount,
      fxRate: c.currencyCode !== base && c.fxRate ? c.fxRate : null,
      method: c.method,
      reference: c.reference.trim() || null,
    })),
  });

  const save = useCMutation(
    (_: void, call) =>
      detail
        ? call<ImportFileDetail>(`/api/import-files/${detail.file.id}`, { method: 'PUT', body: body() })
        : call<ImportFileDetail>('/api/import-files', { method: 'POST', body: body() }),
    IMPORT_INVALIDATE,
  );
  const act = useCMutation(
    (v: { action: 'allocate' | 'reopen' | 'post' | 'cancel'; payload?: unknown }, call) =>
      call<ImportFileDetail>(`/api/import-files/${detail!.file.id}/${v.action}`, { method: 'POST', body: v.payload ?? {} }),
    IMPORT_INVALIDATE,
  );

  // Başarıdan sonra sorgular yenilenince düzenleyici yeniden kurulur (anahtar değişir); bu yüzden sonuç `mutate` geri çağrısıyla
  // değil `mutateAsync` ile beklenir (geri çağrılar bileşen sökülünce çalışmaz).
  const run = async (v: { action: 'allocate' | 'reopen' | 'post' | 'cancel'; payload?: unknown }, done: string, after?: () => void) => {
    setError(null);
    try {
      await act.mutateAsync(v);
      toast.success(done);
      after?.();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onSave = async () => {
    setError(null);
    try {
      const res = await save.mutateAsync();
      toast.success(detail ? t('landed.messages.saved') : t('landed.messages.created'));
      setDirty(false);
      if (!detail) navigate(`/inventory/imports/${res.file.id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Önizleme: kaydedilmemiş girdiyle, paylaşılan saf dağıtım fonksiyonuyla (sunucu aynı fonksiyonu kullanır)
  const allocLines: AllocLine[] = useMemo(() => lines.map((l, i) => ({ key: String(i + 1), quantity: l.quantity, value: l.value, weight: l.weight || null })), [lines]);
  const costBase = (c: FormCost): string | null => {
    if (!c.amount || dec(c.amount).lte(0)) return null;
    if (c.currencyCode === base) return c.amount;
    return c.fxRate ? dec(c.amount).times(c.fxRate).toDecimalPlaces(2).toFixed(2) : null;
  };
  const preview = (c: FormCost, ci: number): { amounts: string[] | null; error: string | null } => {
    const b = costBase(c);
    if (!b || lines.length === 0) return { amounts: null, error: null };
    try {
      return { amounts: allocateAmount(b, c.method as LandedMethod, allocLines, manual[String(ci + 1)]).map((a) => a.toFixed(2)), error: null };
    } catch (e) {
      return { amounts: null, error: e instanceof AllocationError ? e.message : String(e) };
    }
  };

  const serverAlloc = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of detail?.allocations ?? []) m.set(`${a.costLineId}|${a.fileLineId}`, a.amount);
    return m;
  }, [detail]);

  const hasManual = costs.some((c) => c.method === 'manual');
  const showResult = status !== 'draft' && !!detail;
  const goodsTotal = lines.reduce((s, l) => s.plus(l.value || 0), dec(0));
  const costTotal = costs.reduce((s, c) => s.plus(costBase(c) ?? 0), dec(0));

  const report = useCQuery<ImportReport>(['import-report', detail?.file.id], detail && status !== 'draft' ? `/api/import-files/${detail.file.id}/report` : null);

  const addSources = (list: ImportSource[]) => {
    setLines((cur) => [
      ...cur,
      ...list.map((s) => ({ sourceKind: s.kind, sourceLineId: s.sourceLineId, docNo: s.docNo, itemCode: s.itemCode, itemName: s.itemName, unit: s.unit, quantity: s.quantity, value: s.value, weight: '' })),
    ]);
    setDirty(true);
    setPicker(false);
  };

  const title = detail ? `${detail.file.code} — ${detail.file.name}` : t('landed.newTitle');
  return (
    <div className="print-wide">
      <PageHeader
        title={title}
        description={detail ? undefined : t('landed.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {detail && <ImportStatusBadge status={status} />}
            {detail && status !== 'draft' && <ExportMenu exportKey="import-file-report" params={{ id: detail.file.id }} />}
            {editable && (
              <Button variant="primary" loading={save.isPending} disabled={!name.trim() || !dirty} onClick={() => void onSave()}>
                {t('landed.actions.save')}
              </Button>
            )}
            {detail && status === 'draft' && can('invoices.manage') && (
              <Button loading={act.isPending} disabled={dirty} title={dirty ? t('landed.actions.saveFirst') : undefined} onClick={() => void run({ action: 'allocate', payload: hasManual ? { manual } : {} }, t('landed.messages.allocated'))}>
                {t('landed.actions.allocate')}
              </Button>
            )}
            {detail && status === 'allocated' && can('invoices.manage') && (
              <Button loading={act.isPending} onClick={() => window.confirm(t('landed.actions.confirmReopen')) && void run({ action: 'reopen' }, t('landed.messages.reopened'))}>
                {t('landed.actions.reopen')}
              </Button>
            )}
            {detail && status === 'allocated' && can('invoices.post') && (
              <Button variant="primary" onClick={() => setPostOpen(true)}>
                {t('landed.actions.post')}
              </Button>
            )}
            {detail && status !== 'cancelled' && can('invoices.post') && (
              <Button onClick={() => setCancelOpen(true)}>{t('landed.actions.cancel')}</Button>
            )}
          </div>
        }
      />
      <PrintHeader subtitle={detail ? `${t(`landed.status.${status}`)} · ${formatDateTR(detail.file.fileDate)}` : undefined} note={t('landed.notice')} />
      {error && (
        <div className="mb-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}
      <div className="mb-4 print:hidden">
        <Callout tone="warning">{t('landed.notice')}</Callout>
      </div>

      <Card className="mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold">{t('landed.header')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('landed.name')} required className="lg:col-span-2">
            {(i) => <Input id={i} value={name} maxLength={120} disabled={!editable} onChange={(e) => touch(setName)(e.target.value)} />}
          </Field>
          <Field label={t('landed.reference')}>{(i) => <Input id={i} value={reference} maxLength={100} disabled={!editable} onChange={(e) => touch(setReference)(e.target.value)} />}</Field>
          <Field label={t('landed.fileDate')} required>{(i) => <Input id={i} type="date" value={fileDate} disabled={!editable} onChange={(e) => touch(setFileDate)(e.target.value)} />}</Field>
          <Field label={t('landed.defaultMethod')}>
            {(i) => (
              <Select id={i} value={method} disabled={!editable} onChange={(e) => touch(setMethod)(e.target.value as ImportMethod)}>
                {IMPORT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`landed.methods.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('landed.description')} className="sm:col-span-2 lg:col-span-3">
            {(i) => <Textarea id={i} rows={2} value={description} maxLength={500} disabled={!editable} onChange={(e) => touch(setDescription)(e.target.value)} />}
          </Field>
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader
          title={t('landed.goods.title')}
          description={t('landed.goods.hint')}
          action={
            editable && (
              <Button onClick={() => setPicker(true)}>
                <Plus className="size-4" aria-hidden />
                {t('landed.goods.add')}
              </Button>
            )
          }
        />
        {lines.length === 0 ? (
          <p className="p-5 text-sm text-muted">{t('landed.goods.empty')}</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10">#</Th>
                  <Th>{t('landed.goods.doc')}</Th>
                  <Th>{t('landed.goods.item')}</Th>
                  <Th num>{t('landed.goods.qty')}</Th>
                  <Th num>{t('landed.goods.value')} ({base})</Th>
                  <Th num className="w-36">{t('landed.goods.weight')}</Th>
                  {editable && <Th className="w-12 print:hidden" />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <Tr key={l.sourceLineId}>
                    <Td className="text-muted">{i + 1}</Td>
                    <Td className="font-mono text-[13px]">
                      {l.docNo} <span className="font-sans text-xs text-muted">{t(l.sourceKind === 'invoice' ? 'landed.goods.kindInvoice' : 'landed.goods.kindDelivery')}</span>
                    </Td>
                    <Td>
                      <span className="mr-2 font-mono text-xs text-muted">{l.itemCode}</span>
                      {l.itemName}
                    </Td>
                    <Td num>
                      {qtyText(l.quantity)} {l.unit}
                    </Td>
                    <Td num>{money(l.value)}</Td>
                    <Td num>
                      {editable ? (
                        <MoneyInput aria-label={`${t('landed.goods.weight')} ${i + 1}`} value={l.weight} decimals={0} maxDecimals={4} onChange={(v) => { setLines(lines.map((x, j) => (j === i ? { ...x, weight: v } : x))); setDirty(true); }} />
                      ) : (
                        qtyText(l.weight)
                      )}
                    </Td>
                    {editable && (
                      <Td className="print:hidden">
                        <Button size="sm" variant="ghost" aria-label={`${t('landed.goods.remove')} ${i + 1}`} onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader
          title={t('landed.costs.title')}
          description={t('landed.costs.hint')}
          action={
            editable && (
              <Button onClick={() => { setCosts([...costs, { kind: 'freight', description: '', partyId: '', currencyCode: base, amount: '', fxRate: '', method, reference: '' }]); setDirty(true); }}>
                <Plus className="size-4" aria-hidden />
                {t('landed.costs.add')}
              </Button>
            )
          }
        />
        {costs.length === 0 ? (
          <p className="p-5 text-sm text-muted">{t('landed.costs.empty')}</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10">#</Th>
                  <Th>{t('landed.costs.kind')}</Th>
                  <Th>{t('landed.costs.description')}</Th>
                  <Th>{t('landed.costs.party')}</Th>
                  <Th>{t('landed.costs.currency')}</Th>
                  <Th num>{t('landed.costs.amount')}</Th>
                  <Th num>{t('landed.costs.fxRate')}</Th>
                  <Th num>{t('landed.costs.base')} ({base})</Th>
                  <Th>{t('landed.costs.method')}</Th>
                  {editable && <Th className="w-12 print:hidden" />}
                </tr>
              </thead>
              <tbody>
                {costs.map((c, i) => {
                  const patch = (p: Partial<FormCost>) => { setCosts(costs.map((x, j) => (j === i ? { ...x, ...p } : x))); setDirty(true); };
                  const serverBase = detail?.costLines[i]?.amountBase;
                  const b = costBase(c);
                  return (
                    <Tr key={i}>
                      <Td className="text-muted">{i + 1}</Td>
                      <Td>
                        {editable ? (
                          <Select aria-label={`${t('landed.costs.kind')} ${i + 1}`} value={c.kind} onChange={(e) => patch({ kind: e.target.value as ImportCostKind })}>
                            {IMPORT_COST_KINDS.map((k) => (
                              <option key={k} value={k}>{t(`landed.kinds.${k}`)}</option>
                            ))}
                          </Select>
                        ) : (
                          t(`landed.kinds.${c.kind}`)
                        )}
                      </Td>
                      <Td>
                        {editable ? <Input aria-label={`${t('landed.costs.description')} ${i + 1}`} value={c.description} maxLength={200} onChange={(e) => patch({ description: e.target.value })} /> : c.description}
                      </Td>
                      <Td className="min-w-44">
                        {editable ? (
                          <Combobox aria-label={`${t('landed.costs.party')} ${i + 1}`} options={[{ value: '', label: t('landed.costs.noParty') }, ...partyOptions]} value={c.partyId} onChange={(v) => patch({ partyId: v })} />
                        ) : (
                          detail?.costLines[i]?.partyName
                        )}
                      </Td>
                      <Td>
                        {editable ? (
                          <Select aria-label={`${t('landed.costs.currency')} ${i + 1}`} value={c.currencyCode} onChange={(e) => patch({ currencyCode: e.target.value, fxRate: '' })}>
                            <CurrencyOptions />
                          </Select>
                        ) : (
                          c.currencyCode
                        )}
                      </Td>
                      <Td num>{editable ? <MoneyInput aria-label={`${t('landed.costs.amount')} ${i + 1}`} value={c.amount} onChange={(v) => patch({ amount: v })} /> : money(c.amount)}</Td>
                      <Td num>
                        {c.currencyCode === base ? '' : editable ? (
                          <MoneyInput aria-label={`${t('landed.costs.fxRate')} ${i + 1}`} value={c.fxRate} decimals={4} maxDecimals={8} onChange={(v) => patch({ fxRate: v })} />
                        ) : (
                          c.fxRate ? money(c.fxRate, 4) : ''
                        )}
                      </Td>
                      <Td num>{serverBase && !dirty ? money(serverBase) : b ? money(b) : ''}</Td>
                      <Td>
                        {editable ? (
                          <Select aria-label={`${t('landed.costs.method')} ${i + 1}`} value={c.method} onChange={(e) => patch({ method: e.target.value as ImportMethod })}>
                            {IMPORT_METHODS.map((m) => (
                              <option key={m} value={m}>{t(`landed.methods.${m}`)}</option>
                            ))}
                          </Select>
                        ) : (
                          t(`landed.methods.${c.method}`)
                        )}
                      </Td>
                      {editable && (
                        <Td className="print:hidden">
                          <Button size="sm" variant="ghost" aria-label={`${t('landed.costs.remove')} ${i + 1}`} onClick={() => { setCosts(costs.filter((_, j) => j !== i)); setDirty(true); }}>
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <div className="flex flex-wrap justify-end gap-6 border-t border-border px-5 py-3 text-sm">
          <span>
            {t('landed.totals.goods')}: <strong className="tabular-nums">{money(goodsTotal.toFixed(2))}</strong>
          </span>
          <span>
            {t('landed.totals.costs')}: <strong className="tabular-nums">{money(costTotal.toFixed(2))}</strong>
          </span>
          <span>
            {t('landed.totals.landed')}: <strong className="tabular-nums">{money(goodsTotal.plus(costTotal).toFixed(2))}</strong>
          </span>
        </div>
      </Card>

      {lines.length > 0 && costs.length > 0 && (
        <Card className="mb-5">
          <CardHeader title={t('landed.alloc.title')} description={showResult ? t('landed.alloc.result') : hasManual ? t('landed.alloc.manualHint') : t('landed.alloc.preview')} />
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('landed.alloc.cost')}</Th>
                  {lines.map((l, i) => (
                    <Th key={l.sourceLineId} num>
                      #{i + 1} {l.itemCode}
                    </Th>
                  ))}
                  <Th num>{t('landed.alloc.total')}</Th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c, ci) => {
                  const pv = preview(c, ci);
                  const serverCost = detail?.costLines[ci];
                  const manualRow = manual[String(ci + 1)] ?? {};
                  const manualSum = lines.reduce((s, _, li) => s.plus(manualRow[String(li + 1)] || 0), dec(0));
                  const b = costBase(c);
                  return (
                    <Tr key={ci}>
                      <Td>
                        {ci + 1}. {t(`landed.kinds.${c.kind}`)}
                        {pv.error && <span role="alert" className="block text-xs text-danger">{pv.error}</span>}
                        {!pv.error && !pv.amounts && !showResult && c.method !== 'manual' && <span className="block text-xs text-muted">{t('landed.alloc.previewUnavailable')}</span>}
                      </Td>
                      {lines.map((l, li) => (
                        <Td key={l.sourceLineId} num>
                          {showResult && serverCost ? (
                            money(serverAlloc.get(`${serverCost.id}|${detail!.lines[li]?.id}`) ?? '0')
                          ) : c.method === 'manual' && editable ? (
                            <MoneyInput
                              aria-label={`${t('landed.alloc.cost')} ${ci + 1} #${li + 1}`}
                              value={manualRow[String(li + 1)] ?? ''}
                              onChange={(v) => setManual({ ...manual, [String(ci + 1)]: { ...manualRow, [String(li + 1)]: v } })}
                            />
                          ) : pv.amounts ? (
                            money(pv.amounts[li])
                          ) : (
                            ''
                          )}
                        </Td>
                      ))}
                      <Td num>
                        {showResult && serverCost ? money(serverCost.amountBase) : c.method === 'manual' && editable && b ? (
                          <span className={manualSum.eq(b) ? '' : 'text-danger'}>
                            {money(manualSum.toFixed(2))} · {t('landed.alloc.diff')} {money(manualSum.minus(b).toFixed(2))}
                          </span>
                        ) : b ? (
                          money(b)
                        ) : (
                          ''
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {detail && status !== 'draft' && (
        <Card className="mb-5">
          <CardHeader title={t('landed.report.title')} />
          {report.isPending ? (
            <PageLoading />
          ) : !report.data ? null : (
            <>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('landed.report.item')}</Th>
                      <Th num>{t('landed.report.qty')}</Th>
                      <Th num>{t('landed.report.goods')}</Th>
                      <Th num>{t('landed.report.allocated')}</Th>
                      <Th num>{t('landed.report.landed')}</Th>
                      <Th num>{t('landed.report.before')}</Th>
                      <Th num>{t('landed.report.after')}</Th>
                      {status === 'posted' && <Th num>{t('landed.report.stocked')}</Th>}
                      {status === 'posted' && <Th num>{t('landed.report.cogs')}</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.byItem.map((it) => {
                      const ls = report.data!.byLine.filter((l) => l.itemId === it.itemId);
                      const stocked = ls.reduce((s, l) => s.plus(l.stockedAmount ?? 0), dec(0));
                      const cogs = ls.reduce((s, l) => s.plus(l.cogsAmount ?? 0), dec(0));
                      const u = landedUnitCost(it.quantity, it.goodsValue, it.allocated);
                      return (
                        <Tr key={it.itemId}>
                          <Td>
                            <span className="mr-2 font-mono text-xs text-muted">{it.itemCode}</span>
                            {it.itemName}
                          </Td>
                          <Td num>{qtyText(it.quantity)} {it.unit}</Td>
                          <Td num>{money(it.goodsValue)}</Td>
                          <Td num>{money(it.allocated)}</Td>
                          <Td num>{money(it.landedValue)}</Td>
                          <Td num>{u.before ? money(u.before.toFixed(4), 4) : ''}</Td>
                          <Td num>{u.after ? money(u.after.toFixed(4), 4) : ''}</Td>
                          {status === 'posted' && <Td num>{money(stocked.toFixed(2))}</Td>}
                          {status === 'posted' && <Td num>{money(cogs.toFixed(2))}</Td>}
                        </Tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-2">
                      <Td>{t('common.total')}</Td>
                      <Td />
                      <Td num>{money(report.data.totals.goodsValue)}</Td>
                      <Td num>{money(report.data.totals.allocated)}</Td>
                      <Td num>{money(report.data.totals.landedValue)}</Td>
                      <Td />
                      <Td />
                      {status === 'posted' && <Td />}
                      {status === 'posted' && <Td />}
                    </tr>
                  </tfoot>
                </Table>
              </TableWrap>
              <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-5 py-3 text-sm">
                <span className="text-muted">{t('landed.report.kindTotals')}:</span>
                {report.data.byCost.map((k) => (
                  <span key={k.kind}>
                    {t(`landed.kinds.${k.kind}`)}: <strong className="tabular-nums">{money(k.amount)}</strong>
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {detail && (detail.file.journalEntryNo || detail.file.cancelJournalEntryNo) && (
        <Card className="mb-5 p-5 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            {detail.file.journalEntryNo && (
              <div>
                {t('landed.refs.journal')}:{' '}
                <Link className="link font-mono" to={`/accounting/journal?open=${detail.file.journalEntryId}`}>
                  {detail.file.journalEntryNo}
                </Link>
              </div>
            )}
            {detail.file.stockDocumentNo && (
              <div>
                {t('landed.refs.stockDoc')}: <span className="font-mono">{detail.file.stockDocumentNo}</span>
              </div>
            )}
            {detail.file.cancelJournalEntryNo && (
              <div>
                {t('landed.refs.cancelJournal')}: <span className="font-mono">{detail.file.cancelJournalEntryNo}</span>
              </div>
            )}
            {detail.file.cancelReason && (
              <div>
                {t('landed.refs.cancelReason')}: {detail.file.cancelReason}
              </div>
            )}
          </div>
        </Card>
      )}

      {detail && (
        <Card className="mb-5 print:hidden">
          <CardHeader title={t('landed.history.title')} />
          <ul className="divide-y divide-border text-sm">
            {detail.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-4 px-5 py-2">
                <span className="w-44 text-muted">{new Date(e.createdAt).toLocaleString('tr-TR')}</span>
                <span>{t(`landed.history.${e.action as 'created'}` as never, { defaultValue: e.action })}</span>
                <span className="text-muted">{e.userName}</span>
                {e.note && <span className="text-muted">— {e.note}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SourcePicker open={picker} onClose={() => setPicker(false)} taken={new Set(lines.map((l) => l.sourceLineId))} onAdd={addSources} />

      <Modal
        open={postOpen}
        onOpenChange={setPostOpen}
        title={t('landed.postDialog.title')}
        footer={
          <>
            <Button onClick={() => setPostOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} onClick={() => void run({ action: 'post', payload: { date: postDate } }, t('landed.messages.posted'), () => setPostOpen(false))}>
              {t('landed.actions.post')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('landed.postDialog.hint')}</p>
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('landed.postDialog.date')}>{(i) => <Input id={i} type="date" value={postDate} onChange={(e) => setPostDate(e.target.value)} />}</Field>
        </div>
      </Modal>

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('landed.cancelDialog.title')}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={act.isPending}
              disabled={!cancelReason.trim()}
              onClick={() => void run({ action: 'cancel', payload: { reason: cancelReason.trim(), ...(status === 'posted' ? { date: cancelDate } : {}) } }, t('landed.messages.cancelled'), () => setCancelOpen(false))}
            >
              {t('landed.actions.cancel')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {status === 'posted' && <p className="text-sm text-muted">{t('landed.cancelDialog.postedHint')}</p>}
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('landed.cancelDialog.reason')} required>{(i) => <Input id={i} value={cancelReason} maxLength={300} onChange={(e) => setCancelReason(e.target.value)} />}</Field>
          {status === 'posted' && <Field label={t('landed.cancelDialog.date')}>{(i) => <Input id={i} type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} />}</Field>}
        </div>
      </Modal>
    </div>
  );
}

function SourcePicker({ open, onClose, taken, onAdd }: { open: boolean; onClose: () => void; taken: Set<string>; onAdd: (list: ImportSource[]) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<string, ImportSource>>({});
  const qs = new URLSearchParams({ limit: '100' });
  if (q.trim()) qs.set('q', q.trim());
  const { data, isPending } = useCQuery<{ sources: ImportSource[] }>(['import-sources', qs.toString()], `/api/import-files/sources?${qs}`, { enabled: open });
  const rows = (data?.sources ?? []).filter((s) => !taken.has(s.sourceLineId));
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('landed.goods.pickTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={Object.keys(sel).length === 0} onClick={() => { onAdd(Object.values(sel)); setSel({}); }}>
            {t('landed.goods.pickAdd')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input aria-label={t('common.search')} placeholder={t('landed.goods.pickSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
        {isPending ? (
          <PageLoading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('landed.goods.pickEmpty')}</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-auto rounded-lg border border-border text-sm">
            {rows.map((s) => (
              <li key={s.sourceLineId}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={!!sel[s.sourceLineId]}
                    onChange={(e) => {
                      const next = { ...sel };
                      if (e.target.checked) next[s.sourceLineId] = s;
                      else delete next[s.sourceLineId];
                      setSel(next);
                    }}
                  />
                  <span className="font-mono text-xs">{s.docNo}</span>
                  <span className="flex-1">
                    <span className="mr-2 font-mono text-xs text-muted">{s.itemCode}</span>
                    {s.itemName}
                    <span className="block text-xs text-muted">{s.partyName} · {formatDateTR(s.docDate)}</span>
                  </span>
                  <span className="text-right tabular-nums">
                    {qtyText(s.quantity)} {s.unit}
                    <span className="block text-xs text-muted">{money(s.value)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
