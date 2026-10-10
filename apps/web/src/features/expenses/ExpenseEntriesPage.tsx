import { dec, roundMoney, todayIso } from '@erp/shared';
import { Plus, Receipt } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ExpenseEntry, EmployeeRow, AdvanceRegister } from '../../lib/types';
import { usePartyOptions, useTaxRates, vatRateFor } from '../invoices/common';
import { ProjectWbsFields } from '../projects/common';
import { accountLabel, useTreasuryAccounts } from '../treasury/common';
import { EXPENSE_INVALIDATE, useExpenseCardOptions } from './common';
import { ApiError } from '../../lib/api';
import { APPROVAL_INVALIDATE, type FinancialDraft } from '../approvals/common';
import { FinancialDraftList } from '../settings/DocumentApprovalsPage';

interface Form {
  cardId: string;
  entryDate: string;
  description: string;
  net: string;
  /** 'default' = kartın varsayılanı, 'none' = KDV yok, aksi halde kod. */
  taxChoice: string;
  withholding: string;
  whTouched: boolean;
  paymentKind: 'treasury' | 'party' | 'employee';
  employeeId: string;
  advanceId: string;
  treasuryAccountId: string;
  partyId: string;
  dueDate: string;
  documentRef: string;
  projectId: string;
  wbsId: string;
  projectTouched: boolean;
}

const blank = (): Form => ({
  cardId: '',
  entryDate: todayIso(),
  description: '',
  net: '',
  taxChoice: 'default',
  withholding: '',
  whTouched: false,
  paymentKind: 'treasury',
  employeeId: '',
  advanceId: '',
  treasuryAccountId: '',
  partyId: '',
  dueDate: '',
  documentRef: '',
  projectId: '',
  wbsId: '',
  projectTouched: false,
});

/** Gider fişleri: hızlı gider girişi (kasa/banka ya da cari karşılığı), liste, iptal. */
export function ExpenseEntriesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const employeeLedgerEnabled = useModuleEnabled('hr.employee_ledger');
  const canEmployee = employeeLedgerEnabled && can('hr.payroll_manage');
  const base = useCompany().baseCurrency;
  const { cards, byId, options: cardOptions } = useExpenseCardOptions();
  const { options: partyOptions } = usePartyOptions('supplier');
  const { data: rates } = useTaxRates();
  const { data: tAccounts } = useTreasuryAccounts();
  const taxCodes = useMemo(
    () => [...new Set((rates?.taxRates ?? []).map((r) => r.code))].sort(),
    [rates],
  );
  const treasury = (tAccounts?.accounts ?? []).filter((a) => a.currencyCode === base && a.isActive);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cardId, setCardId] = useState('');
  const [q, setQ] = useState('');
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (cardId) qs.set('cardId', cardId);
  if (q.trim()) qs.set('q', q.trim());
  const { data, isPending } = useCQuery<{
    entries: ExpenseEntry[];
    total: number;
    totals: { net: string; gross: string };
  }>(['expense-entries', qs.toString()], `/api/expense-entries?${qs}`);

  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancel, setCancel] = useState<{
    entry: ExpenseEntry;
    reason: string;
    date: string;
  } | null>(null);
  const { data: staff } = useCQuery<{ employees: EmployeeRow[] }>(
    ['employees', 'expense-pickers'],
    '/api/employees',
    { enabled: canEmployee && form?.paymentKind === 'employee' },
  );
  const { data: advances } = useCQuery<AdvanceRegister>(
    ['employee-ledger', 'expense-advances', form?.employeeId ?? ''],
    form?.employeeId
      ? `/api/employee-ledger/advances?status=outstanding&employeeId=${form.employeeId}`
      : null,
    { enabled: canEmployee && form?.paymentKind === 'employee' },
  );

  const card = form ? byId.get(form.cardId) : undefined;
  // Önizleme (sunucu aynı hesabı kaydederken yapar): KDV kodu, gider tarihindeki oran
  const calc = useMemo(() => {
    if (!form || !form.net || dec(form.net).lte(0)) return null;
    const code =
      form.taxChoice === 'default'
        ? card?.taxCode
        : form.taxChoice === 'none'
          ? null
          : form.taxChoice;
    const vatRate = dec(vatRateFor(rates?.taxRates ?? [], code, form.entryDate));
    const whRate = dec((form.whTouched ? form.withholding : card?.withholdingRate) || 0);
    const net = dec(form.net);
    const vat = roundMoney(net.times(vatRate).div(100));
    const wh = roundMoney(net.times(whRate).div(100));
    return { vat, wh, gross: net.plus(vat), payable: net.plus(vat).minus(wh) };
  }, [form, card, rates]);
  const selectedAdvance = advances?.rows.find((a) => a.id === form?.advanceId);
  const applied =
    calc && selectedAdvance
      ? dec(selectedAdvance.open).lt(calc.payable)
        ? dec(selectedAdvance.open)
        : calc.payable
      : dec(0);
  const reimbursement = calc?.payable.minus(applied) ?? dec(0);

  const create = useCMutation(
    async (f: Form, call) => {
      const body={
          entryDate: f.entryDate,
          cardId: f.cardId,
          description: f.description.trim(),
          net: f.net,
          paymentKind: f.paymentKind,
          treasuryAccountId: f.paymentKind !== 'party' ? f.treasuryAccountId || null : null,
          employeeId: f.paymentKind === 'employee' ? f.employeeId : null,
          advanceId: f.paymentKind === 'employee' ? f.advanceId || null : null,
          partyId: f.partyId || null,
          dueDate: f.paymentKind === 'party' && f.dueDate ? f.dueDate : null,
          documentRef: f.documentRef.trim() || null,
          ...(f.taxChoice === 'default'
            ? {}
            : { taxCode: f.taxChoice === 'none' ? null : f.taxChoice }),
          ...(f.whTouched ? { withholdingRate: f.withholding || null } : {}),
          ...(f.projectTouched
            ? { projectId: f.projectId || null, wbsId: f.projectId ? f.wbsId || null : null }
            : {}),
      };
      try{return await call<{entry?:ExpenseEntry;approvalDraftId?:string}>('/api/expense-entries',{method:'POST',body});}
      catch(e){if(e instanceof ApiError&&e.code==='APPROVAL_REQUIRED'){const {draft}=await call<{draft:FinancialDraft}>('/api/financial-approval-drafts',{method:'POST',body:{docType:'expense',payload:body}});await call(`/api/financial-approval-drafts/${draft.id}/submit`,{method:'POST',body:{}});return {approvalDraftId:draft.id};}throw e;}
    },
    [...EXPENSE_INVALIDATE, ['employee-ledger'], ['activity-report'],...APPROVAL_INVALIDATE],
  );
  const cancelMut = useCMutation(
    (v: { id: string; reason: string; date: string }, call) =>
      call(`/api/expense-entries/${v.id}/cancel`, {
        method: 'POST',
        body: { reason: v.reason, date: v.date },
      }),
    [...EXPENSE_INVALIDATE, ['employee-ledger'], ['activity-report']],
  );

  const submit = () => {
    if (!form) return;
    setError(null);
    create.mutate(form, {
      onSuccess: result => {
        toast.success(result.approvalDraftId?'Gider taslağı onaya gönderildi; henüz mali kayıt oluşmadı':t('expenses.form.saved'));
        setForm(null);
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  const valid =
    !!form &&
    !!form.cardId &&
    !!form.description.trim() &&
    !!form.net &&
    dec(form.net).gt(0) &&
    (form.paymentKind === 'treasury'
      ? !!form.treasuryAccountId
      : form.paymentKind === 'party'
        ? !!form.partyId
        : canEmployee &&
          !!form.employeeId &&
          (!!form.advanceId || !!form.treasuryAccountId) &&
          (!form.advanceId || !!selectedAdvance) &&
          (reimbursement.lte(0) || !!form.treasuryAccountId));

  return (
    <>
      <PageHeader
        title={t('expenses.entries.title')}
        description={t('expenses.entries.subtitle')}
        actions={
          can('treasury.post') && (
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                setForm(blank());
              }}
            >
              <Plus className="size-4" aria-hidden />
              {t('expenses.entries.add')}
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Callout tone="warning">{t('expenses.notice')}</Callout>
      </div>
      <FinancialDraftList type="expense"/>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('common.from')}>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          )}
        </Field>
        <Field label={t('common.to')}>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          )}
        </Field>
        <Field label={t('expenses.entries.card')}>
          {(id) => (
            <Select
              id={id}
              value={cardId}
              onChange={(e) => setCardId(e.target.value)}
              className="w-48"
            >
              <option value="">{t('expenses.entries.all')}</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Input
          aria-label={t('common.search')}
          placeholder={t('expenses.entries.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-64"
        />
        <div className="ml-auto">
          <ExportMenu
            exportKey="expense-entries"
            params={{ from, to, cardId, q }}
            print={false}
            disabled={!data?.entries.length}
          />
        </div>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.entries.length ? (
        <Card>
          <EmptyState
            icon={<Receipt className="size-5" />}
            title={t('expenses.entries.empty')}
            description={t('expenses.entries.emptyHint')}
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('expenses.entries.no')}</Th>
                  <Th>{t('expenses.entries.date')}</Th>
                  <Th>{t('expenses.entries.card')}</Th>
                  <Th>{t('expenses.entries.description')}</Th>
                  <Th>{t('expenses.entries.party')}</Th>
                  <Th num>{t('expenses.entries.net')}</Th>
                  <Th num>{t('expenses.entries.vat')}</Th>
                  <Th num>{t('expenses.entries.withholding')}</Th>
                  <Th num>{t('expenses.entries.gross')}</Th>
                  <Th>{t('expenses.entries.status')}</Th>
                  <Th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <Tr key={e.id} className={e.status === 'cancelled' ? 'opacity-60' : undefined}>
                    <Td className="font-mono text-[13px]">
                      <Link
                        to={`/accounting/journal?open=${e.journalEntryId}`}
                        className="link"
                        title={t('expenses.entries.journal')}
                      >
                        {e.entryNo}
                      </Link>
                    </Td>
                    <Td>{formatDateTR(e.entryDate)}</Td>
                    <Td>{e.cardName}</Td>
                    <Td className="max-w-xs truncate" title={e.documentRef ?? undefined}>
                      {e.description}
                    </Td>
                    <Td>
                      {e.employeeName ?? e.partyName}
                      {e.paymentKind === 'employee' && (
                        <div className="mt-1 space-y-0.5 text-xs text-muted">
                          {dec(e.advanceAppliedAmount).gt(0) && (
                            <p>
                              {e.advanceNumber} · {t('expenses.form.advanceApplied')}:{' '}
                              {money(e.advanceAppliedAmount)} {base}
                            </p>
                          )}
                          <p>
                            {t('expenses.form.reimbursement')}:{' '}
                            {money(dec(e.payable).minus(e.advanceAppliedAmount).toFixed(2))} {base}
                            {e.treasuryAccountName ? ` · ${e.treasuryAccountName}` : ''}
                          </p>
                        </div>
                      )}
                    </Td>
                    <Td num>{money(e.net)}</Td>
                    <Td num className="text-muted">
                      {money(e.vat)}
                    </Td>
                    <Td num className="text-muted">
                      {e.withholding !== '0.0000' ? money(e.withholding) : ''}
                    </Td>
                    <Td num>{money(e.gross)}</Td>
                    <Td>
                      <Badge tone={e.status === 'posted' ? 'success' : 'danger'}>
                        {t(`expenses.entries.${e.status}`)}
                      </Badge>
                    </Td>
                    <Td className="text-right">
                      {e.status === 'posted' &&
                        can('treasury.post') &&
                        (e.paymentKind !== 'employee' || canEmployee) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCancel({ entry: e, reason: '', date: todayIso() })}
                          >
                            {t('expenses.cancel.button')}
                          </Button>
                        )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={5}>{t('expenses.entries.totalNet')}</Td>
                  <Td num>{money(data.totals.net)}</Td>
                  <Td colSpan={2} />
                  <Td num>{money(data.totals.gross)}</Td>
                  <Td colSpan={2} />
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        </>
      )}

      <Modal
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={t('expenses.form.title')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={submit}>
              {t('expenses.form.save')}
            </Button>
          </>
        }
      >
        {form && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) submit();
            }}
          >
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('expenses.form.card')} required>
                {(id) => (
                  <Combobox
                    id={id}
                    options={cardOptions}
                    value={form.cardId || null}
                    placeholder={t('expenses.form.pickCard')}
                    onChange={(v) => {
                      const c = byId.get(v);
                      setForm({
                        ...form,
                        cardId: v,
                        ...(form.projectTouched
                          ? {}
                          : { projectId: c?.projectId ?? '', wbsId: c?.wbsId ?? '' }),
                        ...(form.whTouched ? {} : { withholding: c?.withholdingRate ?? '' }),
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={t('expenses.form.date')} required>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={form.entryDate}
                    onChange={(e) => setForm({ ...form, entryDate: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label={t('expenses.form.description')} required>
              {(id) => (
                <Input
                  id={id}
                  value={form.description}
                  maxLength={300}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={`${t('expenses.form.net')} (${base})`} required>
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={form.net}
                    onChange={(v) => setForm({ ...form, net: v })}
                  />
                )}
              </Field>
              <Field label={t('expenses.form.taxCode')}>
                {(id) => (
                  <Select
                    id={id}
                    value={form.taxChoice}
                    onChange={(e) => setForm({ ...form, taxChoice: e.target.value })}
                  >
                    <option value="default">
                      {t('expenses.form.defaultTax')}
                      {card ? ` (${card.taxCode ?? t('expenses.form.noTax')})` : ''}
                    </option>
                    <option value="none">{t('expenses.form.noTax')}</option>
                    {taxCodes.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('expenses.form.withholdingRate')}>
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={form.withholding}
                    decimals={0}
                    maxDecimals={4}
                    onChange={(v) => setForm({ ...form, withholding: v, whTouched: true })}
                  />
                )}
              </Field>
            </div>
            {calc && (
              <div className="grid gap-2 rounded-lg bg-surface-2 p-3 text-sm sm:grid-cols-4">
                <span>
                  {t('expenses.form.vat')}:{' '}
                  <strong className="tabular-nums">{money(calc.vat.toFixed(2))}</strong>
                </span>
                <span>
                  {t('expenses.form.withholding')}:{' '}
                  <strong className="tabular-nums">{money(calc.wh.toFixed(2))}</strong>
                </span>
                <span>
                  {t('expenses.form.gross')}:{' '}
                  <strong className="tabular-nums">{money(calc.gross.toFixed(2))}</strong>
                </span>
                <span>
                  {t('expenses.form.payable')}:{' '}
                  <strong className="tabular-nums">{money(calc.payable.toFixed(2))}</strong>
                </span>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('expenses.form.payment')}>
                {(id) => (
                  <Select
                    id={id}
                    value={form.paymentKind}
                    onChange={(e) =>
                      setForm({ ...form, paymentKind: e.target.value as Form['paymentKind'] })
                    }
                  >
                    <option value="treasury">{t('expenses.form.paymentTreasury')}</option>
                    <option value="party">{t('expenses.form.paymentParty')}</option>
                    {canEmployee && (
                      <option value="employee">{t('expenses.form.paymentEmployee')}</option>
                    )}
                  </Select>
                )}
              </Field>
              {form.paymentKind !== 'party' ? (
                <Field
                  label={t('expenses.form.treasuryAccount')}
                  required={form.paymentKind === 'treasury' || reimbursement.gt(0)}
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={form.treasuryAccountId}
                      onChange={(e) => setForm({ ...form, treasuryAccountId: e.target.value })}
                    >
                      <option value="" />
                      {treasury.map((a) => (
                        <option key={a.id} value={a.id}>
                          {accountLabel(a)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <Field label={t('expenses.form.dueDate')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="date"
                      value={form.dueDate}
                      min={form.entryDate}
                      onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                    />
                  )}
                </Field>
              )}
            </div>
            {form.paymentKind === 'employee' && (
              <div className="space-y-3 rounded-xl border border-border p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('expenses.form.employee')} required>
                    {(id) => (
                      <Combobox
                        id={id}
                        options={(staff?.employees ?? []).map((e) => ({
                          value: e.id,
                          label: `${e.code} · ${e.fullName}`,
                        }))}
                        value={form.employeeId || null}
                        onChange={(employeeId) => setForm({ ...form, employeeId, advanceId: '' })}
                      />
                    )}
                  </Field>
                  <Field label={t('expenses.form.advance')} hint={t('expenses.form.advanceHint')}>
                    {(id) => (
                      <Select
                        id={id}
                        value={form.advanceId}
                        onChange={(e) => setForm({ ...form, advanceId: e.target.value })}
                      >
                        <option value="">{t('expenses.form.noAdvance')}</option>
                        {(advances?.rows ?? [])
                          .filter((a) => a.advanceDate <= form.entryDate)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.number} · {money(a.open)} {base}
                            </option>
                          ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <div className="flex flex-wrap justify-between gap-3 rounded-lg bg-surface-2 p-3 text-sm">
                  <span>
                    {t('expenses.form.advanceApplied')}:{' '}
                    <strong>
                      {money(applied.toFixed(2))} {base}
                    </strong>
                  </span>
                  <span>
                    {t('expenses.form.reimbursement')}:{' '}
                    <strong>
                      {money(reimbursement.toFixed(2))} {base}
                    </strong>
                  </span>
                </div>
                <p className="text-xs text-muted">{t('expenses.form.employeeHint')}</p>
              </div>
            )}
            <Field
              label={
                form.paymentKind === 'party'
                  ? t('expenses.form.party')
                  : t('expenses.form.partyOptional')
              }
              required={form.paymentKind === 'party'}
            >
              {(id) => (
                <Combobox
                  id={id}
                  options={
                    form.paymentKind === 'party'
                      ? partyOptions
                      : [{ value: '', label: '—' }, ...partyOptions]
                  }
                  value={form.partyId || (form.paymentKind === 'party' ? null : '')}
                  onChange={(v) => setForm({ ...form, partyId: v })}
                />
              )}
            </Field>
            <ProjectWbsFields
              projectId={form.projectId}
              wbsId={form.wbsId}
              onChange={(n) =>
                setForm({ ...form, projectId: n.projectId, wbsId: n.wbsId, projectTouched: true })
              }
              label={t('expenses.form.project')}
            />
            <Field label={t('expenses.form.documentRef')} hint={t('expenses.form.documentRefHint')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.documentRef}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, documentRef: e.target.value })}
                />
              )}
            </Field>
          </form>
        )}
      </Modal>

      <Modal
        open={!!cancel}
        onOpenChange={(o) => !o && setCancel(null)}
        title={t('expenses.cancel.title')}
        footer={
          <>
            <Button onClick={() => setCancel(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={cancelMut.isPending}
              disabled={!cancel?.reason.trim()}
              onClick={() =>
                cancel &&
                cancelMut.mutate(
                  { id: cancel.entry.id, reason: cancel.reason.trim(), date: cancel.date },
                  {
                    onSuccess: () => {
                      toast.success(t('expenses.cancel.done'));
                      setCancel(null);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              {t('expenses.cancel.button')}
            </Button>
          </>
        }
      >
        {cancel && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              {cancel.entry.entryNo} — {cancel.entry.description}
            </p>
            <Field label={t('expenses.cancel.reason')} required>
              {(id) => (
                <Input
                  id={id}
                  value={cancel.reason}
                  maxLength={300}
                  onChange={(e) => setCancel({ ...cancel, reason: e.target.value })}
                  autoFocus
                />
              )}
            </Field>
            <Field label={t('expenses.cancel.date')}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={cancel.date}
                  min={cancel.entry.entryDate}
                  onChange={(e) => setCancel({ ...cancel, date: e.target.value })}
                />
              )}
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}
