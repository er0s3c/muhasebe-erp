import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CURRENCY_CODES } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { useCMutation } from '../../lib/queries';
import type { Party, PartyKind } from '../../lib/types';

interface FormState {
  name: string;
  code: string;
  kind: PartyKind;
  phone: string;
  email: string;
  taxNumber: string;
  taxOffice: string;
  address: string;
  currencyCode: string;
  creditLimit: string;
  paymentTermDays: string;
  notes: string;
}

const empty: FormState = {
  name: '',
  code: '',
  kind: 'customer',
  phone: '',
  email: '',
  taxNumber: '',
  taxOffice: '',
  address: '',
  currencyCode: 'TRY',
  creditLimit: '',
  paymentTermDays: '0',
  notes: '',
};

const fromParty = (p: Party): FormState => ({
  name: p.name,
  code: p.code,
  kind: p.kind,
  phone: p.phone ?? '',
  email: p.email ?? '',
  taxNumber: p.taxNumber ?? '',
  taxOffice: p.taxOffice ?? '',
  address: p.address ?? '',
  currencyCode: p.currencyCode,
  creditLimit: p.creditLimit ? p.creditLimit.replace(/\.?0+$/, '') : '',
  paymentTermDays: String(p.paymentTermDays),
  notes: p.notes ?? '',
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse düzenleme; yoksa yeni cari */
  party?: Party | null;
  onSaved: (party: Party) => void;
}

/** Cari kartı formu (yeni/düzenle) — yan panelde açılır. */
export function PartyFormSheet({ open, onOpenChange, party, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editing = !!party;

  useEffect(() => {
    if (open) {
      setF(party ? fromParty(party) : empty);
      setError(null);
      setErrors({});
    }
  }, [open, party]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((cur) => ({ ...cur, [key]: value }));

  const save = useCMutation(
    async (_: void, call) => {
      const term = Number(f.paymentTermDays || '0');
      if (editing) {
        // Boş metin alanı temizler (sunucu şeması)
        const res = await call<{ party: Party }>(`/api/parties/${party.id}`, {
          method: 'PATCH',
          body: {
            name: f.name.trim(),
            kind: f.kind,
            phone: f.phone,
            email: f.email,
            taxNumber: f.taxNumber,
            taxOffice: f.taxOffice,
            address: f.address,
            currencyCode: f.currencyCode,
            creditLimit: f.creditLimit === '' ? null : f.creditLimit,
            paymentTermDays: term,
            notes: f.notes,
          },
        });
        return res.party;
      }
      const res = await call<{ party: Party }>('/api/parties', {
        method: 'POST',
        body: {
          name: f.name.trim(),
          kind: f.kind,
          ...(f.code.trim() ? { code: f.code.trim() } : {}),
          phone: f.phone,
          email: f.email,
          taxNumber: f.taxNumber,
          taxOffice: f.taxOffice,
          address: f.address,
          currencyCode: f.currencyCode,
          ...(f.creditLimit ? { creditLimit: f.creditLimit } : {}),
          paymentTermDays: term,
          notes: f.notes,
        },
      });
      return res.party;
    },
    [['parties'], ['party'], ['dashboard']],
  );

  const submit = () => {
    setError(null);
    setErrors({});
    save.mutate(undefined, {
      onSuccess: (saved) => {
        toast.success(editing ? t('parties.updated') : t('parties.created'));
        onSaved(saved);
        onOpenChange(false);
      },
      onError: (e) => {
        setErrors(fieldErrors(e));
        setError(errorMessage(e));
      },
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t('parties.form.editTitle') : t('parties.form.newTitle')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={f.name.trim().length < 2} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim().length >= 2) submit();
        }}
        noValidate
      >
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('parties.form.name')} error={errors.name} required>
          {(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />}
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parties.form.kind')}>
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value as PartyKind)}>
                {(['customer', 'supplier', 'both'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`parties.kinds.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('parties.form.code')} hint={editing ? undefined : t('parties.form.codeHint')} error={errors.code}>
            {(id) => <Input id={id} value={f.code} onChange={(e) => set('code', e.target.value)} disabled={editing} placeholder="CR-000001" />}
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parties.form.phone')} error={errors.phone}>
            {(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" />}
          </Field>
          <Field label={t('parties.form.email')} error={errors.email}>
            {(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parties.form.taxNumber')} error={errors.taxNumber}>
            {(id) => <Input id={id} value={f.taxNumber} onChange={(e) => set('taxNumber', e.target.value)} inputMode="numeric" />}
          </Field>
          <Field label={t('parties.form.taxOffice')} error={errors.taxOffice}>
            {(id) => <Input id={id} value={f.taxOffice} onChange={(e) => set('taxOffice', e.target.value)} />}
          </Field>
        </div>
        <Field label={t('parties.form.address')} error={errors.address}>
          {(id) => <Input id={id} value={f.address} onChange={(e) => set('address', e.target.value)} />}
        </Field>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label={t('parties.form.currency')}>
            {(id) => (
              <Select id={id} value={f.currencyCode} onChange={(e) => set('currencyCode', e.target.value)}>
                {CURRENCY_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('parties.form.creditLimit')} hint={t('parties.form.creditLimitHint')} error={errors.creditLimit}>
            {(id) => <MoneyInput id={id} value={f.creditLimit} onChange={(v) => set('creditLimit', v)} />}
          </Field>
          <Field label={t('parties.form.paymentTerm')} error={errors.paymentTermDays}>
            {(id) => (
              <Input id={id} type="number" min={0} max={365} value={f.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} className="num" />
            )}
          </Field>
        </div>
        <Field label={t('parties.form.notes')} error={errors.notes}>
          {(id) => <Textarea id={id} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} />}
        </Field>
      </form>
    </Sheet>
  );
}
