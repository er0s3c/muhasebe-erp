import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencySymbol, TREASURY_PARENT_CODE } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { Account, TreasuryAccount, TreasuryAccountKind } from '../../lib/types';
import { TREASURY_INVALIDATE, useTreasuryAccounts } from './common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse mevcut hesap düzenlenir (tür, para birimi ve bağlı muhasebe hesabı değişmez). */
  account?: TreasuryAccount;
  onSaved: (account: TreasuryAccount) => void;
}

/** Kasa/banka hesabı: yeni alt hesap açar ya da mevcut (100.x / 102.x) muhasebe hesabına bağlar. */
export function AccountFormSheet({ open, onOpenChange, account, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const editing = !!account;

  const [kind, setKind] = useState<TreasuryAccountKind>('bank');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(company.baseCurrency);
  const [bankName, setBankName] = useState('');
  const [branch, setBranch] = useState('');
  const [iban, setIban] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [link, setLink] = useState(false);
  const [linkAccountId, setLinkAccountId] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(account?.kind ?? 'bank');
    setName(account?.name ?? '');
    setCurrency(account?.currencyCode ?? company.baseCurrency);
    setBankName(account?.bankName ?? '');
    setBranch(account?.branch ?? '');
    setIban(account?.iban ?? '');
    setAccountNo(account?.accountNo ?? '');
    setLink(false);
    setLinkAccountId('');
    setError(null);
  }, [open, account, company.baseCurrency]);

  const { data: existing } = useTreasuryAccounts(open && !editing);
  const { data: glData } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts', { enabled: open && !editing });

  // Bağlanabilecek hesaplar: aynı grupta (100 / 102), aynı para biriminde, kayıt atılabilir ve henüz bağlı olmayan
  const linkOptions = useMemo<ComboOption[]>(() => {
    const parent = TREASURY_PARENT_CODE[kind];
    const taken = new Set((existing?.accounts ?? []).map((a) => a.accountId));
    return (glData?.accounts ?? [])
      .filter(
        (a) =>
          (a.code === parent || a.code.startsWith(`${parent}.`)) &&
          a.isPostable &&
          a.isActive &&
          !a.partyControl &&
          (a.currencyCode ?? company.baseCurrency) === currency &&
          !taken.has(a.id),
      )
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code }));
  }, [glData, existing, kind, currency, company.baseCurrency]);

  useEffect(() => setLinkAccountId(''), [kind, currency]);

  const save = useCMutation(
    (_: void, call) => {
      const text = { bankName: bankName.trim(), branch: branch.trim(), iban: iban.trim(), accountNo: accountNo.trim() };
      if (account) {
        return call<{ account: TreasuryAccount }>(`/api/treasury/accounts/${account.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), ...(kind === 'bank' ? text : {}) },
        });
      }
      return call<{ account: TreasuryAccount }>('/api/treasury/accounts', {
        method: 'POST',
        body: {
          kind,
          name: name.trim(),
          currency,
          ...(kind === 'bank' ? Object.fromEntries(Object.entries(text).filter(([, v]) => v)) : {}),
          ...(link && linkAccountId ? { linkAccountId } : {}),
        },
      });
    },
    TREASURY_INVALIDATE,
  );

  const canSave = name.trim().length >= 2 && (!link || !!linkAccountId);
  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: ({ account: saved }) => {
        toast.success(t('treasury.form.saved'));
        onSaved(saved);
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t('treasury.form.editTitle') : t('treasury.form.newTitle')}
      description={editing ? undefined : t('treasury.form.newDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) submit();
        }}
      >
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}

        {!editing && (
          <div>
            <p className="mb-1.5 text-[13px]">{t('treasury.form.kind')}</p>
            <SegmentedTabs value={kind} onChange={setKind} items={(['bank', 'cash'] as const).map((k) => ({ key: k, label: t(`treasury.kinds.${k}`) }))} />
          </div>
        )}

        <Field label={t('treasury.form.name')} required hint={kind === 'cash' ? t('treasury.form.nameHintCash') : t('treasury.form.nameHintBank')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>

        <Field label={t('treasury.form.currency')} hint={editing ? t('treasury.form.currencyLocked') : undefined}>
          {(id) => (
            <Select id={id} value={currency} disabled={editing} onChange={(e) => setCurrency(e.target.value)}>
              <CurrencyOptions wide />
            </Select>
          )}
        </Field>

        {kind === 'bank' && (
          <>
            <Field label={t('treasury.form.bankName')}>{(id) => <Input id={id} value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={80} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('treasury.form.branch')}>{(id) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={80} />}</Field>
              <Field label={t('treasury.form.accountNo')}>{(id) => <Input id={id} value={accountNo} onChange={(e) => setAccountNo(e.target.value)} maxLength={40} />}</Field>
            </div>
            <Field label={t('treasury.form.iban')}>{(id) => <Input id={id} value={iban} onChange={(e) => setIban(e.target.value)} maxLength={34} className="font-mono" />}</Field>
          </>
        )}

        {!editing && (
          <div className="rounded-xl border border-border p-4">
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-text" checked={link} onChange={(e) => setLink(e.target.checked)} />
              <span>
                {t('treasury.form.link', { code: TREASURY_PARENT_CODE[kind] })}
                <span className="mt-0.5 block text-[13px] text-muted">{t('treasury.form.linkHint')}</span>
              </span>
            </label>
            {link && (
              <div className="mt-3">
                <Combobox options={linkOptions} value={linkAccountId || null} onChange={setLinkAccountId} placeholder={t('treasury.form.linkPick')} aria-label={t('treasury.form.linkAria')} />
                {linkOptions.length === 0 && <p className="mt-2 text-[13px] text-muted">{t('treasury.form.linkNone', { code: TREASURY_PARENT_CODE[kind], currency: currencySymbol(currency) })}</p>}
              </div>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}
