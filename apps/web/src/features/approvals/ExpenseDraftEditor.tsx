import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { useExpenseCardOptions } from '../expenses/common';
import { usePartyOptions, useTaxRates } from '../invoices/common';
import { accountLabel, useTreasuryAccounts } from '../treasury/common';
import { APPROVAL_INVALIDATE, type FinancialDraft } from './common';

export function ExpenseDraftEditor({
  draft,
  onClose,
}: {
  draft: FinancialDraft;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState(draft.payload),
    [error, setError] = useState<string | null>(null);
  const toast = useToast(),
    company = useCompany(),
    can = useCan(),
    employeeModule = useModuleEnabled('hr.employee_ledger');
  const { options: cardOptions } = useExpenseCardOptions(),
    { options: partyOptions } = usePartyOptions('supplier'),
    treasury = useTreasuryAccounts(),
    rates = useTaxRates();
  const staff = useCQuery<{ employees: { id: string; fullName: string }[] }>(
    ['employees', 'approval-pickers'],
    '/api/employees',
    { enabled: employeeModule && can('hr.payroll_manage') && payload.paymentKind === 'employee' },
  );
  const patch = (key: string, value: unknown) => setPayload((prev) => ({ ...prev, [key]: value }));
  const save = useCMutation(async (submit: boolean, call) => {
    await call(`/api/financial-approval-drafts/${draft.id}`, {
      method: 'PUT',
      body: { docType: 'expense', payload },
    });
    if (submit)
      await call(`/api/financial-approval-drafts/${draft.id}/submit`, { method: 'POST', body: {} });
  }, APPROVAL_INVALIDATE);
  const submit = (request: boolean) =>
    save.mutate(request, {
      onSuccess: () => {
        toast.success(request ? 'Gider yeniden onaya gönderildi' : 'Gider taslağı kaydedildi');
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  return (
    <Sheet
      wide
      open
      onOpenChange={(open) => !open && onClose()}
      title="Gider onay taslağını düzenle"
      description="Yeni içerik ayrı onay talebine bağlanır. Önceki karar geçmişte korunur."
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button loading={save.isPending && !save.variables} onClick={() => submit(false)}>
            Taslağı kaydet
          </Button>
          <Button
            variant="primary"
            loading={save.isPending && !!save.variables}
            onClick={() => submit(true)}
          >
            Kaydet ve onaya gönder
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Gider kartı">
          {(id) => (
            <Combobox
              id={id}
              options={cardOptions}
              value={String(payload.cardId ?? '')}
              onChange={(value) => patch('cardId', value)}
            />
          )}
        </Field>
        <Field label="Gider tarihi">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={String(payload.entryDate ?? '')}
              onChange={(e) => patch('entryDate', e.target.value)}
            />
          )}
        </Field>
        <Field label="Açıklama" className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              maxLength={500}
              value={String(payload.description ?? '')}
              onChange={(e) => patch('description', e.target.value)}
            />
          )}
        </Field>
        <Field label="KDV hariç tutar">
          {(id) => (
            <MoneyInput
              id={id}
              value={String(payload.net ?? '')}
              onChange={(value) => patch('net', value)}
            />
          )}
        </Field>
        <Field label="KDV kodu">
          {(id) => (
            <Select
              id={id}
              value={String(payload.taxCode ?? '')}
              onChange={(e) => patch('taxCode', e.target.value || null)}
            >
              <option value="">KDV yok</option>
              {[...new Set((rates.data?.taxRates ?? []).map((rate) => rate.code))].map((code) => (
                <option value={code} key={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Stopaj oranı (%)">
          {(id) => (
            <MoneyInput
              id={id}
              decimals={0}
              maxDecimals={4}
              value={String(payload.withholdingRate ?? '0')}
              onChange={(value) => patch('withholdingRate', value || null)}
            />
          )}
        </Field>
        <Field label="Ödeme şekli">
          {(id) => (
            <Select
              id={id}
              value={String(payload.paymentKind ?? 'treasury')}
              onChange={(e) => patch('paymentKind', e.target.value)}
            >
              <option value="treasury">Kasa / banka</option>
              <option value="party">Cari borç</option>
              {employeeModule && can('hr.payroll_manage') && (
                <option value="employee">Personel masrafı</option>
              )}
            </Select>
          )}
        </Field>
        {payload.paymentKind === 'party' ? (
          <Field label="Tedarikçi">
            {(id) => (
              <Combobox
                id={id}
                options={partyOptions}
                value={String(payload.partyId ?? '')}
                onChange={(value) => patch('partyId', value)}
              />
            )}
          </Field>
        ) : (
          <Field label="Kasa / banka">
            {(id) => (
              <Select
                id={id}
                value={String(payload.treasuryAccountId ?? '')}
                onChange={(e) => patch('treasuryAccountId', e.target.value || null)}
              >
                <option value="">Seçin</option>
                {(treasury.data?.accounts ?? [])
                  .filter(
                    (account) => account.isActive && account.currencyCode === company.baseCurrency,
                  )
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        {payload.paymentKind === 'party' && (
          <Field label="Vade">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={String(payload.dueDate ?? '')}
                onChange={(e) => patch('dueDate', e.target.value || null)}
              />
            )}
          </Field>
        )}
        {payload.paymentKind === 'employee' && (
          <>
            <Field label="Personel">
              {(id) => (
                <Select
                  id={id}
                  value={String(payload.employeeId ?? '')}
                  onChange={(e) => {
                    patch('employeeId', e.target.value);
                    patch('advanceId', null);
                  }}
                >
                  <option value="">Seçin</option>
                  {staff.data?.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {!!payload.advanceId && (
              <Callout>
                Seçili personel avansı korunur. Personeli değiştirirseniz avans seçimi kaldırılır.
              </Callout>
            )}
          </>
        )}
        <Field label="Belge referansı">
          {(id) => (
            <Input
              id={id}
              value={String(payload.documentRef ?? '')}
              maxLength={100}
              onChange={(e) => patch('documentRef', e.target.value || null)}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
