import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { applyRate, dec, formatTR, proportionalBase, roundMoney, settlementFxDiff, todayIso, type MoneyValue, formatMoney } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { Account, OpenItem, OpenItemsData, TreasuryTxnDetail, TreasuryTxnType } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { PROJECT_COST_INVALIDATE, ProjectLineRow, isProjectTaggable, projectFields } from '../projects/common';
import { TREASURY_INVALIDATE, TXN_TYPES, accountLabel, useMarketRates, useTreasuryAccounts } from './common';
import { APPROVAL_INVALIDATE, type FinancialDraft } from '../approvals/common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: TreasuryTxnType;
  /** Cari sayfasından açılırsa cari hazır gelir */
  initialPartyId?: string;
  /** Hesap sayfasından açılırsa hesap hazır gelir */
  initialAccountId?: string;
  /**
   * Banka ekstresi satırından hareket oluşturma (satır kilitli mod): tarih, tutar ve hesap satırdan gelir ve
   * değiştirilemez; yalnızca satırın yönüne uyan türler seçilebilir; kayıt `create-transaction` ucuyla yapılır
   * (hareket ve eşleşme aynı işlemde).
   */
  line?: { id: string; date: string; /** Mutlak tutar (kanonik) */ amount: string; direction: 'in' | 'out'; accountId: string; description: string };
  onSaved: (result: TreasuryTxnDetail) => void;
  editingDraft?:FinancialDraft;
}

/** Seçilen açık kalem: kalem para biriminde kapatılan tutar; karşılık (kasa/banka para biriminde) boşsa kurdan önerilir. */
interface ItemState {
  amount: string;
  settle: string | null;
}

const isIso = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const num = (v: string | null | undefined) => dec(v && v !== '' ? v : 0);

/**
 * Kasa/banka hareketi formu: tahsilat/ödeme (açık kalem eşleştirmeli, kur farkı önizlemeli), virman,
 * döviz alım-satım ve diğer tahsilat/ödeme. Önizleme sunucudakiyle aynı ortak formülleri kullanır.
 */
export function TransactionSheet({ open, onOpenChange, initialType = 'receipt', initialPartyId = '', initialAccountId = '', line, onSaved, editingDraft }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const base = company.baseCurrency;

  const startType: TreasuryTxnType = line ? (line.direction === 'in' ? 'receipt' : 'payment') : initialType;
  const allowedTypes = line
    ? TXN_TYPES.filter((k) => (line.direction === 'in' ? k === 'receipt' || k === 'other_receipt' : k === 'payment' || k === 'other_payment'))
    : TXN_TYPES;
  const [type, setType] = useState<TreasuryTxnType>(startType);
  const [date, setDate] = useState(line?.date ?? todayIso());
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  /** null: kalemlerin karşılık toplamı (otomatik) */
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [counterAmount, setCounterAmount] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [partyId, setPartyId] = useState('');
  const [glAccountId, setGlAccountId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [wbsId, setWbsId] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [error, setError] = useState<Error | null>(null);

  const settle = type === 'receipt' || type === 'payment';
  const other = type === 'other_receipt' || type === 'other_payment';
  const customerAdvance = ['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector) && type === 'other_receipt';
  const pair = type === 'transfer' || type === 'exchange';
  const outflow = type !== 'receipt' && type !== 'other_receipt';
  const control = type === 'receipt' ? 'receivable' : 'payable';
  const kind = type === 'receipt' ? 'receipt' : 'payment';

  useEffect(() => {
    if (!open) return;
    setType(startType);
    setDate(String(editingDraft?.payload.date??line?.date ?? todayIso()));
    setAccountId(String(editingDraft?.payload.accountId??line?.accountId ?? initialAccountId));
    setToAccountId('');
    setAmountInput(editingDraft?String(editingDraft.payload.amount):null);
    setCounterAmount('');
    setFxRate(String(editingDraft?.payload.fxRate??''));
    setPartyId(String(editingDraft?.payload.partyId??initialPartyId));
    setGlAccountId(String(editingDraft?.payload.glAccountId??''));
    setProjectId(String(editingDraft?.payload.projectId??''));
    setWbsId(String(editingDraft?.payload.wbsId??''));
    setDescription(String(editingDraft?.payload.description??line?.description ?? ''));
    setItems(Object.fromEntries(((editingDraft?.payload.items??[]) as {lineId:string;amount:string;settleAmount?:string}[]).map(item=>[item.lineId,{amount:item.amount,settle:item.settleAmount??null}])));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startType, initialPartyId, initialAccountId, line?.id]);

  const { data: accData } = useTreasuryAccounts(open);
  // Varsayılan hesap: defter para birimindeki hesaplar önce, sonra banka, sonra kasa
  const accounts = useMemo(
    () =>
      (accData?.accounts ?? [])
        .filter((a) => a.isActive)
        .sort((a, b) => Number(a.currencyCode !== base) - Number(b.currencyCode !== base) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'tr')),
    [accData, base],
  );
  const byId = useMemo(() => new Map((accData?.accounts ?? []).map((a) => [a.id, a])), [accData]);
  useEffect(() => {
    if (open && !accountId && accounts.length > 0) setAccountId(accounts[0]!.id);
  }, [open, accountId, accounts]);

  const from = byId.get(accountId);
  const to = byId.get(toAccountId);
  const fromCur = from?.currencyCode ?? base;
  const toCur = to?.currencyCode ?? base;

  const { options: customerOptions } = usePartyOptions('customer', open && (type === 'receipt' || customerAdvance));
  const { options: supplierOptions } = usePartyOptions('supplier', open && type === 'payment');
  const partyOptions = type === 'receipt' ? customerOptions : supplierOptions;

  const { data: glData } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts', { enabled: open && other });
  const glTaggable = other && isProjectTaggable(glData?.accounts.find((a) => a.id === glAccountId));
  const glOptions = useMemo<ComboOption[]>(() => {
    const linked = new Set((accData?.accounts ?? []).map((a) => a.accountId));
    return (glData?.accounts ?? [])
      .filter((a) => a.isPostable && a.isActive && !a.partyControl && !a.currencyCode && !linked.has(a.id) && !/^10[0-9]/.test(a.code))
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code }));
  }, [glData, accData]);

  const openPath =
    open && settle && partyId && isIso(date) ? `/api/parties/${partyId}/open-items?${new URLSearchParams({ asOf: date, type: control })}` : null;
  const openQ = useCQuery<OpenItemsData>(['party', partyId, 'open-items', date, control], openPath);
  const openItems: OpenItem[] = openQ.data?.[control]?.items ?? [];
  const unapplied = openQ.data?.[control]?.unapplied ?? '0';

  const rates = useMarketRates([fromCur, toCur, ...openItems.map((i) => i.currencyCode)], date, open);
  const showRate = ((settle || other) && fromCur !== base) || (type === 'exchange' && fromCur !== base && toCur !== base);
  const rateCur = type === 'exchange' ? toCur : fromCur;
  const lookedUpRate = rates.rate(rateCur);
  const txnRate: MoneyValue | null = fromCur === base ? dec(1) : fxRate ? dec(fxRate) : rates.rate(fromCur);

  const suggestSettle = (it: OpenItem, amt: MoneyValue): string | null => {
    if (it.currencyCode === fromCur) return amt.toFixed(2);
    const ri = rates.rate(it.currencyCode);
    if (!ri || !txnRate || txnRate.lte(0)) return null;
    return roundMoney(amt.times(ri).div(txnRate)).toFixed(2);
  };
  // Aynı para biriminde karşılık her zaman kapatılan tutardır (sunucu eşitsizliği reddeder: kur farkı değil kısmi kapatma)
  const effSettle = (it: OpenItem, st: ItemState) => (it.currencyCode === fromCur ? st.amount : (st.settle ?? suggestSettle(it, num(st.amount)) ?? ''));

  const selected = openItems.filter((it) => items[it.lineId]);
  const settleTotal = selected.reduce((s, it) => s.plus(num(effSettle(it, items[it.lineId]!))), dec(0));
  const amount = line?.amount ?? amountInput ?? (selected.length > 0 ? settleTotal.toFixed(2) : '');
  const advance = num(amount).minus(settleTotal);

  // Kur farkı önizlemesi (tahsilat/ödeme): kalemin taşıdığı defter tutarı ile karşılığın defter tutarı
  const fx = useMemo(() => {
    if (!settle || !txnRate) return null;
    let net = dec(0);
    for (const it of selected) {
      const st = items[it.lineId]!;
      const amt = num(st.amount);
      if (amt.lte(0) || amt.gt(it.remaining)) continue;
      const carry = proportionalBase(amt, dec(it.remaining), dec(it.remainingBase));
      net = net.plus(settlementFxDiff(kind, carry, applyRate(num(effSettle(it, st)), txnRate)));
    }
    return net;
    // effSettle her render yeniden kurulur; girdileri aşağıdaki bağımlılıklardır
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settle, txnRate?.toString(), selected.map((it) => `${it.lineId}:${items[it.lineId]?.amount}:${items[it.lineId]?.settle}`).join('|'), rates.loading, kind]);

  // Döviz alım-satım önizlemesi: çıkan tutarın maliyeti (ortalama), alınan tutarın değeri ve fark
  const exch = useMemo(() => {
    if (type !== 'exchange' || !from || !to || fromCur === toCur) return null;
    const amt = num(amount);
    const counter = num(counterAmount);
    if (amt.lte(0) || counter.lte(0)) return null;
    let fromBase: MoneyValue | null;
    if (fromCur === base) fromBase = amt;
    else {
      const bal = dec(from.balance);
      const balBase = dec(from.balanceBase);
      const r = rates.rate(fromCur);
      fromBase = bal.gt(0) && bal.gte(amt) && balBase.gt(0) ? proportionalBase(amt, bal, balBase) : r ? applyRate(amt, r) : null;
    }
    let toBase: MoneyValue | null;
    if (toCur === base) toBase = counter;
    else if (fromCur === base) toBase = fromBase;
    else {
      const r = fxRate ? dec(fxRate) : rates.rate(toCur);
      toBase = r ? applyRate(counter, r) : null;
    }
    const diff = fromBase && toBase ? toBase.minus(fromBase) : null;
    // Bir taraf defter para birimiyse fiilî kur: TL tutarı / döviz tutarı
    const implied = fromCur === base ? amt.div(counter) : toCur === base ? counter.div(amt) : null;
    return { diff, implied };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, from, to, amount, counterAmount, fxRate, fromCur, toCur, base, rates.loading]);

  const patchItem = (lineId: string, p: Partial<ItemState>) => setItems((cur) => (cur[lineId] ? { ...cur, [lineId]: { ...cur[lineId]!, ...p } } : cur));
  const toggle = (it: OpenItem) =>
    setItems((cur) => {
      const { [it.lineId]: was, ...rest } = cur;
      return was ? rest : { ...cur, [it.lineId]: { amount: it.remaining, settle: null } };
    });
  const selectAll = () => {
    setAmountInput(null);
    setItems(Object.fromEntries(openItems.map((it) => [it.lineId, { amount: it.remaining, settle: null }])));
  };
  /** Girilen tutarı en eski kalemden başlayarak dağıtır; son kalem kısmi kapanabilir. */
  const allocate = () => {
    let left = num(amount);
    const next: Record<string, ItemState> = {};
    for (const it of openItems) {
      if (left.lte(0)) break;
      const full = suggestSettle(it, dec(it.remaining));
      if (full === null) break;
      if (left.gte(full)) {
        next[it.lineId] = { amount: it.remaining, settle: null };
        left = left.minus(full);
      } else {
        const part = roundMoney(dec(it.remaining).times(left).div(full));
        if (part.lte(0)) break;
        next[it.lineId] = { amount: part.toFixed(2), settle: left.toFixed(2) };
        left = dec(0);
      }
    }
    setAmountInput(amount);
    setItems(next);
  };

  const save = useCMutation(
    async (_: void, call) => {
      const body={
          type,
          // Satır kilitli modda tarih, tutar ve hesabı sunucu ekstre satırından alır
          ...(line ? {} : { date, accountId, amount }),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(settle
            ? {
                partyId,
                items: selected.map((it) => ({ lineId: it.lineId, amount: items[it.lineId]!.amount, settleAmount: effSettle(it, items[it.lineId]!) })),
              }
            : {}),
          ...(pair ? { toAccountId } : {}),
          ...(type === 'exchange' ? { counterAmount } : {}),
          ...(other ? { glAccountId } : {}),
          ...(customerAdvance && partyId ? { partyId } : {}),
          // Proje etiketi yalnızca gelir/gider/maliyet karşı hesabında anlamlıdır (sunucu kuralı)
          ...(glTaggable ? projectFields(projectId, wbsId) : {}),
          ...(showRate && fxRate ? { fxRate } : {}),
      };
      const requestApproval=async()=>{
        const {draft}=await call<{draft:FinancialDraft}>(editingDraft?`/api/financial-approval-drafts/${editingDraft.id}`:'/api/financial-approval-drafts',{method:editingDraft?'PUT':'POST',body:{docType:'payment',payload:body}});
        await call(`/api/financial-approval-drafts/${draft.id}/submit`,{method:'POST',body:{}});
        return {approvalDraftId:draft.id};
      };
      if(editingDraft)return requestApproval();
      try{return await call<TreasuryTxnDetail>(line ? `/api/bank-statement-lines/${line.id}/create-transaction` : '/api/treasury/transactions',{method:'POST',body});}
      catch(e){if(!line&&(type==='payment'||type==='other_payment')&&e instanceof ApiError&&e.code==='APPROVAL_REQUIRED')return requestApproval();throw e;}
    },
    [...TREASURY_INVALIDATE, ...PROJECT_COST_INVALIDATE,...APPROVAL_INVALIDATE],
  );

  const itemProblems = selected.some((it) => {
    const st = items[it.lineId]!;
    const a = num(st.amount);
    const s = num(effSettle(it, st));
    return a.lte(0) || a.gt(it.remaining) || s.lte(0);
  });
  const rateMissing = showRate && !fxRate && !lookedUpRate && !rates.loading;
  const cashLow = !!from && from.kind === 'cash' && outflow && num(amount).gt(from.balance);

  const valid =
    !!from &&
    num(amount).gt(0) &&
    isIso(date) &&
    !rateMissing &&
    (!settle || (!!partyId && !itemProblems && !advance.isNegative())) &&
    (!pair || (!!to && toAccountId !== accountId && (type === 'transfer' ? toCur === fromCur : toCur !== fromCur && num(counterAmount).gt(0)))) &&
    (!other || !!glAccountId);

  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: (res) => {
        if('approvalDraftId'in res){toast.success('Ödeme taslağı onaya gönderildi; henüz mali kayıt oluşmadı');onOpenChange(false);return;}
        toast.success(t('treasury.sheet.saved', { no: res.transaction.txnNo }));
        onSaved(res);
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  const changeType = (k: TreasuryTxnType) => {
    setType(k);
    setPartyId('');
    setGlAccountId('');
    setProjectId('');
    setWbsId('');
    setToAccountId('');
    setCounterAmount('');
    setAmountInput(null);
    setFxRate('');
    setItems({});
    setError(null);
  };
  const changeAccount = (id: string) => {
    setAccountId(id);
    setFxRate('');
    // Karşılıkları yeni hesabın para birimine göre yeniden öner
    setItems((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, { ...v, settle: null }])));
  };

  const fxMissing = error instanceof ApiError && error.code === 'FX_RATE_MISSING';
  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {accountLabel(a)}
    </option>
  ));
  const itemGrid = 'lg:grid-cols-[28px_84px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]';

  return (
    <Sheet
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={line ? t('treasury.sheet.lineTitle') : t('treasury.sheet.title')}
      description={type==='payment'||type==='other_payment'?'Aktif onay kuralı varsa işlem mali taslak olarak onaya gönderilir; son onayda kesinleşir.':undefined}
      footer={
        <>
          <div className="mr-auto text-sm" aria-live="polite">
            {settle && fx !== null && !fx.isZero() ? (
              <span className={fx.gt(0) ? 'text-success' : 'text-danger'}>
                {fx.gt(0) ? t('treasury.sheet.fxGain') : t('treasury.sheet.fxLoss')}: <span className="num">{formatMoney(fx.abs().toFixed(2), base)}</span>
              </span>
            ) : type === 'exchange' && exch?.diff && !exch.diff.isZero() ? (
              <span className={exch.diff.gt(0) ? 'text-success' : 'text-danger'}>
                {exch.diff.gt(0) ? t('treasury.sheet.fxGain') : t('treasury.sheet.fxLoss')}: <span className="num">{formatMoney(exch.diff.abs().toFixed(2), base)}</span>
              </span>
            ) : null}
          </div>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
            {t('treasury.sheet.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {error && (
          <Callout
            tone="danger"
            action={
              fxMissing ? (
                <Link to="/settings/currencies" className="shrink-0 text-sm link" onClick={() => onOpenChange(false)}>
                  {t('ledger.journal.enterFx')}
                </Link>
              ) : undefined
            }
          >
            {errorMessage(error)}
          </Callout>
        )}

        {accData && accounts.length === 0 && (
          <Callout tone="warning" title={t('treasury.sheet.noAccounts')}>
            <Link to="/treasury/accounts" className="link" onClick={() => onOpenChange(false)}>
              {t('treasury.sheet.noAccountsLink')}
            </Link>
          </Callout>
        )}

        {line && <Callout>{t('treasury.sheet.fromLine')}</Callout>}

        <div>
          <p className="mb-1.5 text-[13px]">{t('treasury.sheet.type')}</p>
          <SegmentedTabs variant="filter" value={type} onChange={changeType} items={allowedTypes.map((k) => ({ key: k, label: t(`treasury.types.${k}`) }))} />
          <p className="mt-2 text-[13px] text-muted">{t(`treasury.sheet.hints.${type}`)}</p>
        </div>

        <div className={cn('grid gap-4', pair ? 'sm:grid-cols-[160px_1fr_1fr]' : 'sm:grid-cols-[160px_1fr]')}>
          <Field label={t('treasury.sheet.date')} required>
            {(id) => <Input id={id} type="date" value={date} disabled={!!line} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label={pair ? t('treasury.sheet.fromAccount') : outflow ? t('treasury.sheet.outAccount') : t('treasury.sheet.inAccount')} required>
            {(id) => (
              <Select id={id} value={accountId} disabled={!!line} onChange={(e) => changeAccount(e.target.value)}>
                {accountOptions}
              </Select>
            )}
          </Field>
          {pair && (
            <Field label={t('treasury.sheet.toAccount')} required>
              {(id) => (
                <Select id={id} value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                  <option value="" />
                  {accounts
                    .filter((a) => a.id !== accountId && (type === 'transfer' ? a.currencyCode === fromCur : a.currencyCode !== fromCur))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {accountLabel(a)}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
        </div>

        {from && outflow && (
          <p className="-mt-3 text-[13px] text-muted">
            {t('treasury.sheet.available', { amount: moneyIn(from.balance, from.currencyCode) })}
          </p>
        )}

        <div className={cn('grid gap-4', type === 'exchange' || showRate ? 'sm:grid-cols-2' : 'sm:grid-cols-[minmax(0,260px)]')}>
          <Field label={t(`treasury.sheet.amount.${type}`, { currency: currencySymbol(fromCur) })} required>
            {(id) => (
              <MoneyInput
                id={id}
                value={amount}
                onChange={(v) => setAmountInput(v === '' && settle ? null : v)}
                disabled={!!line}
                placeholder="0,00"
                aria-label={t(`treasury.sheet.amount.${type}`, { currency: currencySymbol(fromCur) })}
              />
            )}
          </Field>
          {type === 'exchange' && (
            <Field label={t('treasury.sheet.counterAmount', { currency: currencySymbol(toCur) })} required>
              {(id) => <MoneyInput id={id} value={counterAmount} onChange={setCounterAmount} placeholder="0,00" aria-label={t('treasury.sheet.counterAmount', { currency: currencySymbol(toCur) })} />}
            </Field>
          )}
          {showRate && (
            <Field label={t(type === 'exchange' ? 'treasury.sheet.rateTo' : 'treasury.sheet.rate', { currency: currencySymbol(rateCur), base: currencySymbol(base) })} hint={lookedUpRate ? undefined : t('treasury.sheet.rateMissingHint')}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={fxRate}
                  decimals={4}
                  maxDecimals={8}
                  placeholder={lookedUpRate ? formatTR(lookedUpRate.toString(), 4) : '?'}
                  aria-label={t('treasury.sheet.rate', { currency: currencySymbol(rateCur), base: currencySymbol(base) })}
                  onChange={setFxRate}
                />
              )}
            </Field>
          )}
        </div>

        {type === 'exchange' && exch?.implied && (
          <p className="-mt-3 text-[13px] text-muted">
            {t('treasury.sheet.impliedRate', { rate: formatTR(exch.implied.toFixed(4), 4), currency: currencySymbol(fromCur === base ? toCur : fromCur), base: currencySymbol(base) })}
          </p>
        )}
        {rateMissing && <Callout tone="warning">{t('treasury.sheet.rateMissing', { currency: currencySymbol(rateCur) })}</Callout>}
        {cashLow && <Callout tone="warning">{t('treasury.sheet.cashLow', { balance: moneyIn(from!.balance, from!.currencyCode) })}</Callout>}

        {customerAdvance && (
          <Field label="Kapora müşterisi" hint="Müşteri kaporasında karşı hesap olarak alınan avans hesabını seçin. Diğer gelir tahsilatlarında boş bırakın.">
            {(id) => <Combobox id={id} value={partyId} onChange={setPartyId} options={customerOptions} />}
          </Field>
        )}
        {settle && (
          <section aria-label={t('treasury.sheet.items')} className="flex flex-col gap-3">
            <Field label={type === 'receipt' ? t('treasury.sheet.customer') : t('treasury.sheet.supplier')} required>
              {(id) => (
                <Combobox
                  id={id}
                  options={partyOptions}
                  value={partyId || null}
                  placeholder={t('treasury.sheet.pickParty')}
                  aria-label={type === 'receipt' ? t('treasury.sheet.customer') : t('treasury.sheet.supplier')}
                  onChange={(v) => {
                    setPartyId(v);
                    setItems({});
                    setAmountInput(null);
                  }}
                />
              )}
            </Field>

            {partyId && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[15px]">{t('treasury.sheet.openItems')}</h3>
                  {openItems.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={selectAll}>
                        {t('treasury.sheet.selectAll')}
                      </Button>
                      <Button size="sm" disabled={num(amount).lte(0)} onClick={allocate}>
                        {t('treasury.sheet.autoAllocate')}
                      </Button>
                      {selected.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setItems({});
                            setAmountInput(null);
                          }}
                        >
                          {t('treasury.sheet.clearSelection')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {openQ.isPending ? (
                  <p className="text-sm text-muted">{t('common.loading')}</p>
                ) : openItems.length === 0 ? (
                  <Callout>{t(`treasury.sheet.noOpenItems.${control}`)}</Callout>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className={cn('grid items-end gap-2 px-1 micro max-lg:hidden', itemGrid)}>
                      <span />
                      <span>{t('parties.detail.dueDate')}</span>
                      <span>{t('common.description')}</span>
                      <span className="text-right">{t('parties.detail.remaining')}</span>
                      <span className="text-right">{t('treasury.sheet.closeAmount')}</span>
                      <span className="text-right">{t('treasury.sheet.settleAmount', { currency: currencySymbol(fromCur) })}</span>
                    </div>
                    {openItems.map((it) => {
                      const st = items[it.lineId];
                      const sameCur = it.currencyCode === fromCur;
                      const over = !!st && num(st.amount).gt(it.remaining);
                      const label = `${it.entryNo} ${it.description}`;
                      return (
                        <div
                          key={it.lineId}
                          className={cn('grid grid-cols-2 items-center gap-2 rounded-lg border p-2 lg:border-0 lg:p-0', itemGrid, st ? 'border-border-strong' : 'border-border')}
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-text"
                            checked={!!st}
                            onChange={() => toggle(it)}
                            aria-label={t('treasury.sheet.selectItem', { name: label })}
                          />
                          <span className="text-[13px] text-muted">{formatDateTR(it.dueDate)}</span>
                          <span className="col-span-2 min-w-0 text-sm lg:col-span-1">
                            <span className="block truncate">{it.description}</span>
                            <span className="block font-mono text-xs text-muted">{it.entryNo}</span>
                          </span>
                          <span className="num text-right text-sm">
                            {moneyIn(it.remaining, it.currencyCode)}
                          </span>
                          {st ? (
                            <>
                              <MoneyInput
                                value={st.amount}
                                aria-label={t('treasury.sheet.closeAmountOf', { name: label })}
                                className={over ? 'border-danger' : undefined}
                                onChange={(v) => patchItem(it.lineId, { amount: v })}
                              />
                              {sameCur ? (
                                <span className="num text-right text-[13px] text-muted">= {money(st.amount || '0')}</span>
                              ) : (
                                <MoneyInput
                                  value={effSettle(it, st)}
                                  placeholder="?"
                                  aria-label={t('treasury.sheet.settleAmountOf', { name: label })}
                                  onChange={(v) => patchItem(it.lineId, { settle: v })}
                                />
                              )}
                            </>
                          ) : (
                            <span className="col-span-2 text-right text-[13px] text-muted max-lg:hidden lg:col-span-2" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {num(unapplied).gt(0) && <p className="text-[13px] text-muted">{t('treasury.sheet.existingAdvance', { amount: moneyIn(unapplied, base) })}</p>}

                <dl className="grid gap-x-8 gap-y-2 rounded-xl border border-border bg-surface-2/50 p-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted">{t('treasury.sheet.allocated')}</dt>
                    <dd className="mt-0.5 tabular-nums">
                      {moneyIn(settleTotal.toFixed(2), fromCur)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('treasury.sheet.advance')}</dt>
                    <dd className={cn('mt-0.5 tabular-nums', advance.isNegative() && 'text-danger')}>
                      {advance.isNegative() ? t('treasury.sheet.exceeds') : moneyIn(advance.toFixed(2), fromCur)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('treasury.sheet.fxDiff')}</dt>
                    <dd className={cn('mt-0.5 tabular-nums', fx && fx.gt(0) && 'text-success', fx && fx.isNegative() && 'text-danger')}>
                      {fx === null ? '—' : fx.isZero() ? t('treasury.sheet.noFxDiff') : `${fx.gt(0) ? '+' : '−'}${moneyIn(fx.abs().toFixed(2), base)}`}
                    </dd>
                  </div>
                </dl>
                {advance.gt(0) && <p className="text-[13px] text-muted">{t('treasury.sheet.advanceNote')}</p>}
              </>
            )}
          </section>
        )}

        {type === 'exchange' && exch && (
          <dl className="grid gap-x-8 gap-y-2 rounded-xl border border-border bg-surface-2/50 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t('treasury.sheet.fxDiff')}</dt>
              <dd className={cn('mt-0.5 tabular-nums', exch.diff?.gt(0) && 'text-success', exch.diff?.isNegative() && 'text-danger')}>
                {exch.diff === null ? '—' : exch.diff.isZero() ? t('treasury.sheet.noFxDiff') : `${exch.diff.gt(0) ? '+' : '−'}${moneyIn(exch.diff.abs().toFixed(2), base)}`}
              </dd>
            </div>
            <p className="text-[13px] text-muted sm:self-end">{t('treasury.sheet.exchangeNote')}</p>
          </dl>
        )}

        {other && (
          <Field label={t('treasury.sheet.glAccount')} required hint={t('treasury.sheet.glAccountHint')}>
            {(id) => (
              <Combobox
                id={id}
                options={glOptions}
                value={glAccountId || null}
                onChange={(v) => {
                  setGlAccountId(v);
                  setProjectId('');
                  setWbsId('');
                }}
                placeholder={t('treasury.sheet.pickGl')}
                aria-label={t('treasury.sheet.glAccount')}
              />
            )}
          </Field>
        )}
        {glTaggable && (
          <ProjectLineRow
            projectId={projectId}
            wbsId={wbsId}
            onChange={(n) => {
              setProjectId(n.projectId);
              setWbsId(n.wbsId);
            }}
          />
        )}

        <Field label={t('treasury.sheet.description')}>
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />}
        </Field>
      </div>
    </Sheet>
  );
}
