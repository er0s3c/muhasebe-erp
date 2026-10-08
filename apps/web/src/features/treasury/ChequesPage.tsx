import { CHEQUE_STATUSES, MATURITY_BUCKETS, allowedChequeActions, todayIso, type ChequeAction, type ChequeDirection, type ChequeDocType } from '@erp/shared';
import { History, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ChequeActionResult, ChequeBatchRow, ChequeBouncedReport, ChequeDetail, ChequeDueReport, ChequeList, ChequeMaturity, ChequeRow } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { useTreasuryAccounts } from './common';
import { CHEQUE_INVALIDATE, ChequeStatusBadge, DateField, DirectionBadge, ItemPicker, UnverifiedNotice, pickedPayload, pickedTotal, type PickedItems } from './cheques-common';

type Tab = 'portfolio' | 'clearing' | 'reports';

/**
 * Çek/senet portföyü ve takas (Faz X1). Her durum değişikliği yevmiye yazar; hesap eşlemeleri (101/121/108/103/321) doğrulanmamış
 * varsayılanlardır ve Ayarlar > Hesap eşlemesi'nden değiştirilir. Belge para birimi ve defter karşılığı ayrı saklanır.
 */
export function ChequesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('portfolio');
  return (
    <>
      <PageHeader title={t('cheques.title')} description={t('cheques.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('cheques.notice')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          items={[
            { key: 'portfolio', label: t('cheques.tabs.portfolio') },
            { key: 'clearing', label: t('cheques.tabs.clearing') },
            { key: 'reports', label: t('cheques.tabs.reports') },
          ]}
        />
      </div>
      {tab === 'portfolio' ? <PortfolioTab /> : tab === 'clearing' ? <ClearingTab /> : <ReportsTab />}
    </>
  );
}

const ACTION_BUTTONS: ChequeAction[] = ['deposit', 'collect', 'bounce', 'endorse', 'return', 'unendorse', 'pay', 'cancel'];

function PortfolioTab() {
  const { t } = useTranslation();
  const can = useCan();
  const post = can('treasury.post');
  const [direction, setDirection] = useState('');
  const [docType, setDocType] = useState('');
  const [status, setStatus] = useState('open');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const params = { direction, docType, status, q, dueFrom, dueTo };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v.trim())).toString();
  const lim = useListLimit(qs);
  const { data, isPending } = useCQuery<ChequeList & { truncated?: boolean }>(['cheques', 'list', qs, lim.limit], `/api/cheques?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const [creating, setCreating] = useState<ChequeDirection | null>(null);
  const [acting, setActing] = useState<{ action: ChequeAction; cheque: ChequeRow } | null>(null);
  const [detail, setDetail] = useState<ChequeRow | null>(null);
  const rows = data?.cheques ?? [];
  const today = todayIso();

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('cheques.filters.direction')} className="w-36">
            {(id) => (
              <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="">{t('cheques.filters.all')}</option>
                <option value="received">{t('cheques.direction.received')}</option>
                <option value="issued">{t('cheques.direction.issued')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('cheques.filters.docType')} className="w-32">
            {(id) => (
              <Select id={id} value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="">{t('cheques.filters.all')}</option>
                <option value="cheque">{t('cheques.docType.cheque')}</option>
                <option value="note">{t('cheques.docType.note')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('cheques.filters.status')} className="w-40">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t('cheques.filters.all')}</option>
                <option value="open">{t('cheques.filters.open')}</option>
                {CHEQUE_STATUSES.map((s) => <option key={s} value={s}>{t(`cheques.status.${s}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('cheques.filters.search')} className="w-40">{(id) => <Input id={id} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
          <Field label={t('cheques.filters.dueFrom')} className="w-40">{(id) => <Input id={id} type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} />}</Field>
          <Field label={t('cheques.filters.dueTo')} className="w-40">{(id) => <Input id={id} type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} />}</Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu exportKey="cheques" params={params} disabled={!data || rows.length === 0} />
          {post && (
            <>
              <Button variant="primary" onClick={() => setCreating('received')}>
                <Plus className="size-4" aria-hidden />
                {t('cheques.new.received')}
              </Button>
              <Button onClick={() => setCreating('issued')}>
                <Plus className="size-4" aria-hidden />
                {t('cheques.new.issued')}
              </Button>
            </>
          )}
        </div>
      </div>
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={t('cheques.empty')} description={t('cheques.emptyDesc')} />
        </Card>
      ) : (
        <>
          <TableWrap>
          <Table aria-label={t('cheques.tabs.portfolio')}>
            <thead>
              <tr>
                <Th className="w-24">{t('cheques.cols.direction')}</Th>
                <Th className="w-20">{t('cheques.cols.docType')}</Th>
                <Th className="w-32">{t('cheques.cols.no')}</Th>
                <Th>{t('cheques.cols.bank')}</Th>
                <Th>{t('cheques.cols.party')}</Th>
                <Th className="w-28">{t('cheques.cols.due')}</Th>
                <Th num className="w-32">{t('cheques.cols.amount')}</Th>
                <Th className="w-32">{t('cheques.cols.status')}</Th>
                <Th className="w-56"><span className="sr-only">{t('common.actions')}</span></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const open = (c.direction === 'received' && (c.status === 'portfolio' || c.status === 'in_collection')) || (c.direction === 'issued' && c.status === 'issued');
                const actions = ACTION_BUTTONS.filter((a) => allowedChequeActions(c.direction, c.status).includes(a));
                return (
                  <Tr key={c.id}>
                    <Td><DirectionBadge direction={c.direction} /></Td>
                    <Td>{t(`cheques.docType.${c.docType}`)}</Td>
                    <Td className="font-mono text-[13px]">{c.docNo}</Td>
                    <Td className="text-muted">{c.bankName || '—'}{c.branch ? ` / ${c.branch}` : ''}</Td>
                    <Td>
                      {c.partyName}
                      {c.holderName && <div className="text-xs text-muted">{t('cheques.endorsedTo', { name: c.holderName })}</div>}
                    </Td>
                    <Td className={open && c.dueDate < today ? 'text-danger' : undefined}>{formatDateTR(c.dueDate)}</Td>
                    <Td num>{moneyIn(c.amount, c.currencyCode)}</Td>
                    <Td><ChequeStatusBadge status={c.status} /></Td>
                    <Td>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {post && actions.map((a) => (
                          <Button key={a} size="sm" onClick={() => setActing({ action: a, cheque: c })} aria-label={`${t(`cheques.actions.${a}`)}: ${c.docNo}`}>
                            {t(`cheques.actions.${a}`)}
                          </Button>
                        ))}
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`${t('cheques.history.action')}: ${c.docNo}`} onClick={() => setDetail(c)}>
                          <History className="size-4" aria-hidden />
                        </button>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
          <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
        </>
      )}
      <ChequeSheet direction={creating} onClose={() => setCreating(null)} />
      <ActionModal target={acting} onClose={() => setActing(null)} />
      <DetailSheet cheque={detail} onClose={() => setDetail(null)} />
    </>
  );
}

// --- Yeni çek/senet -----------------------------------------------------------------------------------------------

function ChequeSheet({ direction, onClose }: { direction: ChequeDirection | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = useCompany().baseCurrency;
  const open = direction !== null;
  const received = direction === 'received';
  const { options } = usePartyOptions(received ? 'customer' : 'supplier', open);
  const [f, setF] = useState({ docType: 'cheque' as ChequeDocType, docNo: '', bankName: '', branch: '', partyId: '', amount: '',currency:base,fxRate:'', issueDate: todayIso(), dueDate: '', registerDate: todayIso(), description: '' });
  const [items, setItems] = useState<PickedItems>({});
  const [error, setError] = useState<Error | null>(null);
  const [seen, setSeen] = useState<ChequeDirection | null>(null);
  if (direction !== seen) {
    // Form her açılışta sıfırlanır (render sırasında durum eşitleme)
    setSeen(direction);
    if (direction) {
      setF({ docType: 'cheque', docNo: '', bankName: '', branch: '', partyId: '', amount: '',currency:base,fxRate:'', issueDate: todayIso(), dueDate: '', registerDate: todayIso(), description: '' });
      setItems({});
      setError(null);
    }
  }
  const save = useCMutation(
    (_: void, call) =>
      call<ChequeDetail>('/api/cheques', {
        method: 'POST',
        body: {
          direction,
          docType: f.docType,
          docNo: f.docNo.trim(),
          bankName: f.bankName.trim(),
          ...(f.branch.trim() ? { branch: f.branch.trim() } : {}),
          partyId: f.partyId,
          amount: f.amount,
          currency:f.currency,...(f.currency!==base && f.fxRate?{fxRate:f.fxRate}:{}),
          issueDate: f.issueDate,
          dueDate: f.dueDate,
          registerDate: f.registerDate,
          ...(f.description.trim() ? { description: f.description.trim() } : {}),
          items: pickedPayload(items),
        },
      }),
    CHEQUE_INVALIDATE,
  );
  const used = pickedTotal(items);
  const amountOk = Number(f.amount) > 0;
  const valid = !!f.docNo.trim() && !!f.partyId && amountOk && !!f.dueDate && f.dueDate >= f.issueDate && used.lte(f.amount || '0');
  return (
    <Sheet
      wide
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={received ? t('cheques.new.received') : t('cheques.new.issued')}
      description={t('cheques.new.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!valid}
            onClick={() => save.mutate(undefined, { onSuccess: (r) => { toast.success(t('cheques.new.saved', { no: r.cheque.docNo })); onClose(); }, onError: setError })}
          >
            {t('cheques.new.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cheques.form.docType')} required>
            {(id) => (
              <Select id={id} value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value as ChequeDocType })}>
                <option value="cheque">{t('cheques.docType.cheque')}</option>
                <option value="note">{t('cheques.docType.note')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('cheques.form.no')} required>{(id) => <Input id={id} maxLength={60} autoComplete="off" value={f.docNo} onChange={(e) => setF({ ...f, docNo: e.target.value })} />}</Field>
          <Field label={t('cheques.form.bank')}>{(id) => <Input id={id} maxLength={80} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />}</Field>
          <Field label={t('cheques.form.branch')}>{(id) => <Input id={id} maxLength={80} value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} />}</Field>
          <Field label={received ? t('cheques.form.drawer') : t('cheques.form.payee')} required className="sm:col-span-2">
            {(id) => <Combobox id={id} options={options} value={f.partyId || null} onChange={(v) => { setF({ ...f, partyId: v }); setItems({}); }} placeholder={t('cheques.form.pickParty')} />}
          </Field>
          <Field label="Para birimi">{id=><Select id={id} value={f.currency} onChange={e=>{setF({...f,currency:e.target.value as typeof base,fxRate:''});setItems({});}}><CurrencyOptions /></Select>}</Field>
          <Field label={t('cheques.form.amount', { cur: f.currency })} required>{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}</Field>
          {f.currency!==base && <Field label={`Kayıt kuru: 1 ${currencySymbol(f.currency)} = ${currencySymbol(base)}`} hint="Boş bırakılırsa kayıt tarihindeki geçerli kur kullanılır.">{id=><MoneyInput id={id} value={f.fxRate} decimals={8} onChange={v=>setF({...f,fxRate:v})} />}</Field>}
          <DateField label={t('cheques.form.registerDate')} value={f.registerDate} onChange={(v) => { setF({ ...f, registerDate: v }); setItems({}); }} required />
          <DateField label={t('cheques.form.issueDate')} value={f.issueDate} onChange={(v) => setF({ ...f, issueDate: v })} required />
          <DateField label={t('cheques.form.dueDate')} value={f.dueDate} onChange={(v) => setF({ ...f, dueDate: v })} required />
          <Field label={t('cheques.form.description')} className="sm:col-span-2">{(id) => <Input id={id} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        </div>
        <ItemPicker currency={f.currency} partyId={f.partyId} control={received ? 'receivable' : 'payable'} date={f.registerDate} total={f.amount} items={items} onChange={setItems} />
        <UnverifiedNotice>{received ? t('cheques.form.receivedNote') : t('cheques.form.issuedNote')}</UnverifiedNotice>
      </div>
    </Sheet>
  );
}

// --- Eylem (tek belge) --------------------------------------------------------------------------------------------

function ActionModal({ target, onClose }: { target: { action: ChequeAction; cheque: ChequeRow } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const action = target?.action;
  const cheque = target?.cheque;
  const needsBank = action === 'deposit' || action === 'pay';
  const [date, setDate] = useState(todayIso());
  const [bankId, setBankId] = useState('');
  const [fxRate,setFxRate]=useState('');
  const [partyId, setPartyId] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<PickedItems>({});
  const [error, setError] = useState<Error | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const key = target ? `${target.action}:${target.cheque.id}` : null;
  if (key !== seen) {
    setSeen(key);
    if (key) {
      setDate(todayIso());
      setBankId('');
      setFxRate('');
      setPartyId('');
      setNote('');
      setItems({});
      setError(null);
    }
  }
  const { data: acc } = useTreasuryAccounts(needsBank);
  const base = useCompany().baseCurrency;
  const banks = (acc?.accounts ?? []).filter((a) => a.kind === 'bank' && a.isActive && a.currencyCode === cheque?.currencyCode);
  const { options } = usePartyOptions('supplier', action === 'endorse');
  const run = useCMutation(
    (_: void, call) =>
      call<ChequeActionResult>('/api/cheques/actions', {
        method: 'POST',
        body: {
          action,
          chequeIds: [cheque!.id],
          date,
          ...((action==='collect'||action==='pay')&&cheque?.currencyCode!==base&&fxRate?{fxRate}:{}),
          ...(needsBank ? { bankAccountId: bankId } : {}),
          ...(action === 'endorse' ? { partyId, items: pickedPayload(items) } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    CHEQUE_INVALIDATE,
  );
  const valid = !!date && (!needsBank || !!bankId) && (action !== 'endorse' || (!!partyId && pickedTotal(items).lte(cheque?.amount ?? '0')));
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={action ? `${t(`cheques.actions.${action}`)}: ${cheque?.docNo ?? ''}` : ''}
      description={action ? t(`cheques.actionDesc.${action}`) : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={run.isPending} disabled={!valid} onClick={() => run.mutate(undefined, { onSuccess: (r) => { toast.success(t('cheques.actionDone', { no: r.batch.batchNo })); onClose(); }, onError: setError })}>
            {action ? t(`cheques.actions.${action}`) : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {cheque && <p className="text-sm text-muted">{cheque.partyName} · {moneyIn(cheque.amount, cheque.currencyCode)} · {t('cheques.cols.due')} {formatDateTR(cheque.dueDate)}</p>}
        <DateField label={t('cheques.form.actionDate')} value={date} onChange={(v) => { setDate(v); setItems({}); }} required />
        {(action==='collect'||action==='pay')&&cheque?.currencyCode!==base&&<Field label={`İşlem kuru: 1 ${currencySymbol(cheque?.currencyCode??base)} = ${currencySymbol(base)}`} hint="Boş bırakılırsa işlem tarihindeki geçerli kur kullanılır.">{id=><MoneyInput id={id} value={fxRate} decimals={4} maxDecimals={8} onChange={setFxRate} />}</Field>}
        {needsBank && (
          <Field label={t('cheques.form.bankAccount')} required>
            {(id) => (
              <Select id={id} value={bankId} onChange={(e) => setBankId(e.target.value)}>
                <option value="">{t('cheques.form.pickBank')}</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        {action === 'endorse' && (
          <>
            <Field label={t('cheques.form.endorsee')} required>
              {(id) => <Combobox id={id} options={options} value={partyId || null} onChange={(v) => { setPartyId(v); setItems({}); }} placeholder={t('cheques.form.pickSupplier')} />}
            </Field>
            <ItemPicker currency={cheque?.currencyCode} partyId={partyId} control="payable" date={date} total={cheque?.amount ?? '0'} items={items} onChange={setItems} />
          </>
        )}
        <Field label={t('cheques.form.note')}>{(id) => <Input id={id} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {(action === 'bounce' || action === 'return' || action === 'unendorse' || action === 'cancel') && <Callout tone="info">{t('cheques.reopenNote')}</Callout>}
      </div>
    </Modal>
  );
}

function DetailSheet({ cheque, onClose }: { cheque: ChequeRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const base=useCompany().baseCurrency;
  const { data } = useCQuery<ChequeDetail>(['cheques', 'detail', cheque?.id ?? ''], cheque ? `/api/cheques/${cheque.id}` : null);
  return (
    <Sheet open={!!cheque} onOpenChange={(o) => !o && onClose()} title={cheque ? `${t(`cheques.docType.${cheque.docType}`)} ${cheque.docNo}` : ''} description={t('cheques.history.title')}>
      {!data ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">{t('cheques.cols.party')}</dt><dd>{data.cheque.partyName}</dd>
            <dt className="text-muted">{t('cheques.cols.amount')}</dt><dd>{moneyIn(data.cheque.amount, data.cheque.currencyCode)}</dd>
            <dt className="text-muted">Kayıt defter karşılığı</dt><dd>{moneyIn(data.cheque.amountBase,base)}</dd>
            {data.cheque.currencyCode!==base&&<><dt className="text-muted">Kayıt kuru</dt><dd>1 {data.cheque.currencyCode} = {data.cheque.fxRate} {base}</dd></>}
            <dt className="text-muted">{t('cheques.form.issueDate')}</dt><dd>{formatDateTR(data.cheque.issueDate)}</dd>
            <dt className="text-muted">{t('cheques.cols.due')}</dt><dd>{formatDateTR(data.cheque.dueDate)}</dd>
            <dt className="text-muted">{t('cheques.cols.status')}</dt><dd><ChequeStatusBadge status={data.cheque.status} /></dd>
            {data.cheque.bankAccountName && (<><dt className="text-muted">{t('cheques.form.bankAccount')}</dt><dd>{data.cheque.bankAccountName}</dd></>)}
          </dl>
          <ol className="flex flex-col gap-2" aria-label={t('cheques.history.title')}>
            {data.events.map((e) => (
              <li key={e.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{e.fromStatus ? `${t(`cheques.status.${e.fromStatus}`)} → ` : ''}{t(`cheques.status.${e.toStatus}`)}</span>
                  <span className="text-muted">{formatDateTR(e.eventDate)}</span>
                </div>
                <div className="text-xs text-muted">
                  {e.batchNo && <span className="mr-2">{e.batchNo}</span>}
                  {e.entryNo && <Link className="underline" to={`/accounting/journal?open=${e.entryId}`}>{e.entryNo}</Link>}
                  {e.partyName && <span className="ml-2">{e.partyName}</span>}
                  {e.bankAccountName && <span className="ml-2">{e.bankAccountName}</span>}
                  {e.note && <span className="ml-2">{e.note}</span>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Sheet>
  );
}

// --- Takas (toplu tahsile verme / tahsil / ödeme) ---------------------------------------------------------------------

type ClearingAction = 'deposit' | 'collect' | 'pay';
const CLEARING: Record<ClearingAction, { direction: ChequeDirection; status: string }> = {
  deposit: { direction: 'received', status: 'portfolio' },
  collect: { direction: 'received', status: 'in_collection' },
  pay: { direction: 'issued', status: 'issued' },
};

function ClearingTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const [currency,setCurrency]=useState<string>(base),[fxRate,setFxRate]=useState('');
  const [action, setAction] = useState<ClearingAction>('deposit');
  const { direction, status } = CLEARING[action];
  const { data, isPending } = useCQuery<ChequeList>(['cheques', 'clearing', action], `/api/cheques?${new URLSearchParams({ direction, status })}`);
  const { data: acc } = useTreasuryAccounts();
  const { data: batches } = useCQuery<{ batches: ChequeBatchRow[] }>(['cheques', 'batches'], '/api/cheques/batches');
  const banks = (acc?.accounts ?? []).filter((a) => a.kind === 'bank' && a.isActive && a.currencyCode === currency);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [bankId, setBankId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [filterBank, setFilterBank] = useState('');

  const all = useMemo(() => data?.cheques ?? [], [data]);
  // Tahsil: yalnızca aynı banka hesabına tahsile verilenler birlikte seçilir
  const rows = useMemo(() => all.filter(c=>c.currencyCode===currency&&(action!=='collect'||!filterBank||c.bankAccountId===filterBank)), [all, action, filterBank,currency]);
  const chosen = rows.filter((c) => sel[c.id]);
  const total = chosen.reduce((s, c) => s + Number(c.amount), 0);
  const needsBank = action !== 'collect';
  const run = useCMutation(
    (_: void, call) =>
      call<ChequeActionResult>('/api/cheques/actions', {
        method: 'POST',
        body: { action, chequeIds: chosen.map((c) => c.id), date, ...(needsBank ? { bankAccountId: bankId } : {}), ...((action==='collect'||action==='pay')&&currency!==base&&fxRate?{fxRate}:{}),...(note.trim() ? { note: note.trim() } : {}) },
      }),
    CHEQUE_INVALIDATE,
  );
  const collectBanks = new Set(chosen.map((c) => c.bankAccountId));
  const valid = chosen.length > 0 && !!date && (!needsBank || !!bankId) && (action !== 'collect' || (collectBanks.size === 1 && !collectBanks.has(null)));
  const switchAction = (a: ClearingAction) => { setAction(a); setSel({}); setError(null); setFilterBank(''); };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('cheques.clearing.title')} description={t('cheques.clearing.desc')} />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <SegmentedTabs
            value={action}
            onChange={switchAction}
            items={[
              { key: 'deposit', label: t('cheques.clearing.deposit') },
              { key: 'collect', label: t('cheques.clearing.collect') },
              { key: 'pay', label: t('cheques.clearing.pay') },
            ]}
          />
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Para birimi" className="w-36">{id=><Select id={id} value={currency} onChange={e=>{setCurrency(e.target.value);setSel({});setBankId('');setFilterBank('');setFxRate('');}}><CurrencyOptions /></Select>}</Field>
            {(action==='collect'||action==='pay')&&currency!==base&&<Field label={`1 ${currencySymbol(currency)} = ${currencySymbol(base)}`} hint="Boş: kayıtlı güncel kur" className="w-44">{id=><MoneyInput id={id} value={fxRate} decimals={4} maxDecimals={8} onChange={setFxRate} />}</Field>}
            <DateField label={t('cheques.form.actionDate')} value={date} onChange={setDate} />
            {needsBank && (
              <Field label={t('cheques.form.bankAccount')} className="w-56">
                {(id) => (
                  <Select id={id} value={bankId} onChange={(e) => setBankId(e.target.value)}>
                    <option value="">{t('cheques.form.pickBank')}</option>
                    {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
            {action === 'collect' && (
              <Field label={t('cheques.clearing.depositedTo')} className="w-56">
                {(id) => (
                  <Select id={id} value={filterBank} onChange={(e) => { setFilterBank(e.target.value); setSel({}); }}>
                    <option value="">{t('cheques.filters.all')}</option>
                    {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <Field label={t('cheques.form.note')} className="w-64">{(id) => <Input id={id} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
          {isPending ? (
            <PageLoading />
          ) : rows.length === 0 ? (
            <EmptyState title={t('cheques.clearing.empty')} />
          ) : (
            <TableWrap>
              <Table aria-label={t('cheques.clearing.title')}>
                <thead>
                  <tr>
                    <Th className="w-10">
                      <input type="checkbox" aria-label={t('cheques.clearing.selectAll')} checked={chosen.length === rows.length} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(rows.map((c) => [c.id, true])) : {})} />
                    </Th>
                    <Th className="w-20">{t('cheques.cols.docType')}</Th>
                    <Th className="w-32">{t('cheques.cols.no')}</Th>
                    <Th>{t('cheques.cols.party')}</Th>
                    <Th>{t('cheques.cols.bank')}</Th>
                    <Th className="w-28">{t('cheques.cols.due')}</Th>
                    <Th num className="w-32">{t('cheques.cols.amount')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <Tr key={c.id}>
                      <Td><input type="checkbox" aria-label={c.docNo} checked={!!sel[c.id]} onChange={(e) => setSel({ ...sel, [c.id]: e.target.checked })} /></Td>
                      <Td>{t(`cheques.docType.${c.docType}`)}</Td>
                      <Td className="font-mono text-[13px]">{c.docNo}</Td>
                      <Td>{c.partyName}</Td>
                      <Td className="text-muted">{action === 'collect' ? (c.bankAccountName ?? '—') : c.bankName || '—'}</Td>
                      <Td>{formatDateTR(c.dueDate)}</Td>
                      <Td num>{moneyIn(c.amount, c.currencyCode)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted">{t('cheques.clearing.selected', { n: chosen.length, total: moneyIn(String(total), currency) })}</span>
            {can('treasury.post') && (
              <Button
                variant="primary"
                loading={run.isPending}
                disabled={!valid}
                onClick={() => run.mutate(undefined, { onSuccess: (r) => { setSel({}); setError(null); toast.success(t('cheques.actionDone', { no: r.batch.batchNo })); }, onError: setError })}
              >
                {t(`cheques.clearing.run.${action}`)}
              </Button>
            )}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('cheques.clearing.history')} />
        <div className="px-5 pb-5">
          {(batches?.batches ?? []).length === 0 ? (
            <p className="text-sm text-muted">{t('cheques.clearing.noHistory')}</p>
          ) : (
            <TableWrap>
              <Table aria-label={t('cheques.clearing.history')}>
                <thead>
                  <tr>
                    <Th className="w-36">{t('cheques.clearing.batchNo')}</Th>
                    <Th>{t('cheques.clearing.action')}</Th>
                    <Th className="w-28">{t('cheques.clearing.date')}</Th>
                    <Th num className="w-20">{t('cheques.clearing.count')}</Th>
                    <Th num className="w-32">{t('cheques.cols.amount')}</Th>
                    <Th>{t('cheques.form.bankAccount')}</Th>
                    <Th className="w-32">{t('cheques.clearing.entry')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {batches!.batches.map((b) => (
                    <Tr key={b.id}>
                      <Td className="font-mono text-[13px]">{b.batchNo}</Td>
                      <Td>{t(`cheques.actions.${b.action}`)}{b.partyName ? ` · ${b.partyName}` : ''}</Td>
                      <Td>{formatDateTR(b.eventDate)}</Td>
                      <Td num>{b.docCount}</Td>
                      <Td num>{moneyIn(b.total, b.currencyCode)}</Td>
                      <Td className="text-muted">{b.bankAccountName ?? '—'}</Td>
                      <Td>{b.entryNo ? <Link className="underline" to={`/accounting/journal?open=${b.entryId}`}>{b.entryNo}</Link> : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>
    </div>
  );
}

// --- Raporlar -------------------------------------------------------------------------------------------------------

function ReportsTab() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const [asOf, setAsOf] = useState(todayIso());
  const [days, setDays] = useState('7');
  const maturity = useCQuery<ChequeMaturity>(['cheques', 'maturity', asOf], `/api/cheques/reports/maturity?asOf=${asOf}`);
  const due = useCQuery<ChequeDueReport>(['cheques', 'due', days], `/api/cheques/reports/due?days=${Number(days) >= 0 ? Number(days) : 7}`);
  const bounced = useCQuery<ChequeBouncedReport>(['cheques', 'bounced'], '/api/cheques/reports/bounced');
  const m = maturity.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('cheques.reports.maturity')} description={t('cheques.reports.maturityDesc')} action={<ExportMenu exportKey="cheque-maturity" params={{ asOf }} />} />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <DateField label={t('cheques.reports.asOf')} value={asOf} onChange={setAsOf} />
          {!m ? (
            <PageLoading />
          ) : (
            <>
              <TableWrap>
                <Table aria-label={t('cheques.reports.maturity')}>
                  <thead>
                    <tr>
                      <Th>{t('cheques.reports.bucket')}</Th>
                      <Th num>{t('cheques.direction.received')}</Th>
                      <Th num>{t('cheques.direction.issued')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {MATURITY_BUCKETS.map((b) => {
                      const r = m.received.buckets.find((x) => x.bucket === b)!;
                      const i = m.issued.buckets.find((x) => x.bucket === b)!;
                      return (
                        <Tr key={b}>
                          <Td>{t(`cheques.reports.buckets.${b}`)}</Td>
                          <Td num>{r.count > 0 ? `${moneyIn(r.amount, base)} (${r.count})` : '—'}</Td>
                          <Td num>{i.count > 0 ? `${moneyIn(i.amount, base)} (${i.count})` : '—'}</Td>
                        </Tr>
                      );
                    })}
                    <Tr>
                      <Td className="font-medium">{t('cheques.reports.total')}</Td>
                      <Td num className="font-medium">{moneyIn(m.received.amount, base)} ({m.received.count})</Td>
                      <Td num className="font-medium">{moneyIn(m.issued.amount, base)} ({m.issued.count})</Td>
                    </Tr>
                  </tbody>
                </Table>
              </TableWrap>
              <h3 className="text-sm font-medium">{t('cheques.reports.byParty')}</h3>
              <TableWrap>
                <Table aria-label={t('cheques.reports.byParty')}>
                  <thead>
                    <tr>
                      <Th className="w-24">{t('cheques.cols.direction')}</Th>
                      <Th>{t('cheques.cols.party')}</Th>
                      <Th num className="w-20">{t('cheques.clearing.count')}</Th>
                      <Th num className="w-36">{t('cheques.cols.amount')}</Th>
                      <Th num className="w-36">{t('cheques.reports.overdue')}</Th>
                      <Th className="w-32">{t('cheques.reports.earliest')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.byParty.map((p) => (
                      <Tr key={`${p.direction}:${p.partyId}`}>
                        <Td><DirectionBadge direction={p.direction} /></Td>
                        <Td>{p.partyName}</Td>
                        <Td num>{p.count}</Td>
                        <Td num>{moneyIn(p.amount, base)}</Td>
                        <Td num className={Number(p.overdue) > 0 ? 'text-danger' : undefined}>{Number(p.overdue) > 0 ? moneyIn(p.overdue, base) : '—'}</Td>
                        <Td>{formatDateTR(p.earliestDue)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('cheques.reports.due')} description={t('cheques.reports.dueDesc')} action={<ExportMenu exportKey="cheques-due" params={{ days }} />} />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <Field label={t('cheques.reports.days')} className="w-32">{(id) => <Input id={id} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}</Field>
          {!due.data ? (
            <PageLoading />
          ) : due.data.rows.length === 0 ? (
            <p className="text-sm text-muted">{t('cheques.reports.noneDue')}</p>
          ) : (
            <TableWrap>
              <Table aria-label={t('cheques.reports.due')}>
                <thead>
                  <tr>
                    <Th className="w-24">{t('cheques.cols.direction')}</Th>
                    <Th className="w-32">{t('cheques.cols.no')}</Th>
                    <Th>{t('cheques.cols.party')}</Th>
                    <Th className="w-28">{t('cheques.cols.due')}</Th>
                    <Th num className="w-32">{t('cheques.cols.amount')}</Th>
                    <Th className="w-32">{t('cheques.cols.status')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {due.data.rows.map((r) => (
                    <Tr key={r.id}>
                      <Td><DirectionBadge direction={r.direction} /></Td>
                      <Td className="font-mono text-[13px]">{r.docNo}</Td>
                      <Td>{r.partyName}</Td>
                      <Td className={r.overdue ? 'text-danger' : undefined}>{formatDateTR(r.dueDate)}</Td>
                      <Td num>{moneyIn(r.amount, base)}</Td>
                      <Td><ChequeStatusBadge status={r.status} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          {due.data && <p className="text-xs text-muted">{t('cheques.reports.dueTotals', { received: money(due.data.totals.received), issued: money(due.data.totals.issued) })}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('cheques.reports.bounced')} description={t('cheques.reports.bouncedDesc')} action={<ExportMenu exportKey="cheques-bounced" />} />
        <div className="px-5 pb-5">
          {!bounced.data ? (
            <PageLoading />
          ) : bounced.data.rows.length === 0 ? (
            <p className="text-sm text-muted">{t('cheques.reports.noneBounced')}</p>
          ) : (
            <TableWrap>
              <Table aria-label={t('cheques.reports.bounced')}>
                <thead>
                  <tr>
                    <Th className="w-24">{t('cheques.cols.direction')}</Th>
                    <Th className="w-32">{t('cheques.cols.no')}</Th>
                    <Th>{t('cheques.cols.party')}</Th>
                    <Th className="w-28">{t('cheques.reports.bouncedDate')}</Th>
                    <Th num className="w-24">{t('cheques.reports.daysSince')}</Th>
                    <Th num className="w-32">{t('cheques.cols.amount')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {bounced.data.rows.map((r) => (
                    <Tr key={r.id}>
                      <Td><DirectionBadge direction={r.direction} /></Td>
                      <Td className="font-mono text-[13px]">{r.docNo}</Td>
                      <Td>{r.partyName}</Td>
                      <Td>{r.bouncedDate ? formatDateTR(r.bouncedDate) : '—'}</Td>
                      <Td num>{r.daysSince ?? '—'}</Td>
                      <Td num>{moneyIn(r.amount, base)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      </Card>
    </div>
  );
}
