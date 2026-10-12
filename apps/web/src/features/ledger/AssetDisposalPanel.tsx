import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PackageX } from 'lucide-react';
import {
  assetDisposalSchema,
  disposalResult,
  missingDepreciationMonths,
  todayIso,
  dec,
  type AssetDisposal,
  type AssetDisposalMethod,
  type DepreciationEntry,
  type FixedAsset,
} from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { Account } from '../../lib/types';

const invalidate = [['fixed-assets'], ['journal'], ['journal-entry'], ['reports'], ['dashboard']];
const METHOD: Record<AssetDisposalMethod, string> = { sale: 'Satış', scrap: 'Hurdaya ayırma' };

/**
 * Demirbaş elden çıkarma (öneri 60): satış ya da hurda. Kayıtlı birikmiş amortismanla defter değeri bulunur; maliyet ve
 * birikmiş amortisman kapanır, fark kâr ya da zarar hesabına yazılır. Önceki aylarda kayıtsız amortisman varsa engellenir.
 */
export function AssetDisposalPanel({
  asset,
  history,
  disposals,
}: {
  asset: FixedAsset;
  history: DepreciationEntry[];
  disposals: AssetDisposal[];
}) {
  const can = useCan(),
    toast = useToast(),
    base = useCompany().baseCurrency;
  const [open, setOpen] = useState(false),
    [cancel, setCancel] = useState<AssetDisposal | null>(null),
    [reason, setReason] = useState(''),
    [cancelDate, setCancelDate] = useState(todayIso());
  const active = disposals.find((d) => !d.cancelledAt) ?? null;
  const cancelMut = useCMutation(
    (d: AssetDisposal, call) =>
      call(`/api/fixed-assets/${asset.id}/disposals/${d.id}/cancel`, {
        method: 'POST',
        body: { reason, date: cancelDate },
      }),
    invalidate,
  );
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="font-medium">Elden çıkarma</h3>
        {!active && can('ledger.post') && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <PackageX className="size-4" aria-hidden />
            Sat / hurdaya ayır
          </Button>
        )}
      </div>
      {!disposals.length && (
        <p className="text-sm text-muted">
          Kart kullanımda. Satış ya da hurda kaydı yevmiyeyle kartı kapatır.
        </p>
      )}
      <ul className="space-y-2 text-sm">
        {disposals.map((d) => (
          <li key={d.id} className="rounded-lg bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={d.cancelledAt ? 'neutral' : 'warning'}>
                {d.cancelledAt ? 'İptal' : METHOD[d.method]}
              </Badge>
              <span>{formatDateTR(d.disposalDate)}</span>
              <Link className="link text-xs" to={`/accounting/journal?open=${d.journalEntryId}`}>
                Yevmiye
              </Link>
              {d.reversalEntryId && (
                <Link className="link text-xs" to={`/accounting/journal?open=${d.reversalEntryId}`}>
                  Ters yevmiye
                </Link>
              )}
              {!d.cancelledAt && can('ledger.post') && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => {
                    setReason('');
                    setCancelDate(todayIso() < d.disposalDate ? d.disposalDate : todayIso());
                    setCancel(d);
                  }}
                >
                  İptal et
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              Maliyet {money(d.cost)} · birikmiş {money(d.accumulated)} · defter değeri{' '}
              {money(d.bookValue)} · bedel {money(d.proceeds)} ·{' '}
              <span className={dec(d.gainLoss).lt(0) ? 'text-danger' : ''}>
                {dec(d.gainLoss).lt(0) ? 'zarar' : 'kâr'} {money(dec(d.gainLoss).abs().toFixed(2))}{' '}
                {base}
              </span>
              {d.cancelReason ? ` · iptal: ${d.cancelReason}` : ''}
            </p>
          </li>
        ))}
      </ul>
      {open && <DisposeModal asset={asset} history={history} onClose={() => setOpen(false)} />}
      <Modal
        open={!!cancel}
        onOpenChange={(o) => !o && setCancel(null)}
        title="Elden çıkarmayı iptal et"
        footer={
          <>
            <Button onClick={() => setCancel(null)}>Vazgeç</Button>
            <Button
              variant="primary"
              disabled={
                reason.trim().length < 3 ||
                !cancelDate ||
                (!!cancel && cancelDate < cancel.disposalDate)
              }
              loading={cancelMut.isPending}
              onClick={() =>
                cancel &&
                cancelMut.mutate(cancel, {
                  onSuccess: () => {
                    toast.success('Elden çıkarma iptal edildi; kart yeniden kullanımda.');
                    setCancel(null);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              İptali kaydet
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Yevmiye ters kayıtla nötrlenir ve kart yeniden etkinleşir.
          </p>
          <Field label="İptal gerekçesi">
            {(id) => (
              <Input
                id={id}
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <Field label="Ters yevmiye tarihi">
            {(id) => (
              <Input
                id={id}
                type="date"
                min={cancel?.disposalDate}
                value={cancelDate}
                onChange={(e) => setCancelDate(e.target.value)}
              />
            )}
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function DisposeModal({
  asset,
  history,
  onClose,
}: {
  asset: FixedAsset;
  history: DepreciationEntry[];
  onClose: () => void;
}) {
  const toast = useToast(),
    base = useCompany().baseCurrency;
  const accounts = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts');
  const [form, setForm] = useState({
    date: todayIso(),
    method: 'sale' as AssetDisposalMethod,
    proceeds: '0',
    assetAccountId: '',
    proceedsAccountId: '',
    gainAccountId: '',
    lossAccountId: '',
    note: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const options = (accounts.data?.accounts ?? []).filter(
    (a) =>
      a.isActive && a.isPostable && !a.partyControl && (!a.currencyCode || a.currencyCode === base),
  );
  const combo = (types: string[]) =>
    options
      .filter((a) => types.includes(a.type))
      .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const proceeds = form.method === 'sale' ? form.proceeds || '0' : '0';
  const result = disposalResult(asset.config.cost, asset.postedAmount, proceeds);
  const gl = dec(result.gainLoss);
  const posted = new Set(
    history.filter((h) => !h.cancelledAt && h.entryStatus === 'posted').map((h) => h.month),
  );
  const missing = missingDepreciationMonths(asset.config, form.date.slice(0, 7), posted);
  const save = useCMutation(
    (body: unknown, call) =>
      call(`/api/fixed-assets/${asset.id}/dispose`, { method: 'POST', body }),
    invalidate,
  );
  const submit = () => {
    const parsed = assetDisposalSchema.safeParse({
      ...form,
      proceeds,
      proceedsAccountId: form.proceedsAccountId || null,
      gainAccountId: form.gainAccountId || null,
      lossAccountId: form.lossAccountId || null,
      version: asset.version,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Alanları kontrol edin.');
      return;
    }
    setError(null);
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Demirbaş elden çıkarıldı; yevmiye kaydedildi.');
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Demirbaşı elden çıkar"
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={missing.length > 0}
            onClick={submit}
          >
            Kaydet ve kartı kapat
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        {missing.length > 0 && (
          <Callout tone="warning">
            Elden çıkarma ayından önceki {missing.length} ayın amortismanı kayıtlı değil (
            {missing.slice(0, 3).join(', ')}
            {missing.length > 3 ? '…' : ''}). Önce amortismanı oluşturup kaydedin.
          </Callout>
        )}
        {dec(asset.draftAmount).gt(0) && (
          <Callout tone="warning">Taslak amortisman var; önce kaydedin ya da iptal edin.</Callout>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Yöntem">
            {(id) => (
              <Select
                id={id}
                value={form.method}
                onChange={(e) => set('method', e.target.value as AssetDisposalMethod)}
              >
                <option value="sale">Satış</option>
                <option value="scrap">Hurdaya ayırma</option>
              </Select>
            )}
          </Field>
          <Field label="Tarih">
            {(id) => (
              <Input
                id={id}
                type="date"
                min={asset.config.acquisitionDate}
                max={todayIso()}
                value={form.date}
                onChange={(e) => set('date', e.target.value)}
              />
            )}
          </Field>
        </div>
        {form.method === 'sale' && (
          <Field
            label={`Satış bedeli, KDV hariç (${base})`}
            hint="Satış faturasını ayrıca kestiyseniz karşı hesap olarak faturadaki geçici hesabı seçin."
          >
            {(id) => (
              <MoneyInput id={id} value={form.proceeds} onChange={(v) => set('proceeds', v)} />
            )}
          </Field>
        )}
        <Field
          label="Demirbaş maliyet hesabı"
          hint="Kartın maliyetinin izlendiği varlık hesabı (ör. 253, 254, 255)."
        >
          {(id) => (
            <Combobox
              id={id}
              value={form.assetAccountId || null}
              options={combo(['asset'])}
              onChange={(v) => set('assetAccountId', v)}
            />
          )}
        </Field>
        {form.method === 'sale' && dec(proceeds).gt(0) && (
          <Field label="Satış bedeli karşı hesabı">
            {(id) => (
              <Combobox
                id={id}
                value={form.proceedsAccountId || null}
                options={combo(['asset'])}
                onChange={(v) => set('proceedsAccountId', v)}
              />
            )}
          </Field>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-surface-2 p-3 text-sm">
          <dt className="text-muted">Maliyet</dt>
          <dd className="text-right">{money(asset.config.cost)}</dd>
          <dt className="text-muted">Kayıtlı birikmiş amortisman</dt>
          <dd className="text-right">{money(asset.postedAmount)}</dd>
          <dt className="text-muted">Defter değeri</dt>
          <dd className="text-right">{money(result.bookValue)}</dd>
          <dt className="font-medium">{gl.lt(0) ? 'Zarar' : 'Kâr'}</dt>
          <dd className={`text-right font-medium ${gl.lt(0) ? 'text-danger' : ''}`}>
            {money(gl.abs().toFixed(2))} {base}
          </dd>
        </dl>
        {gl.gt(0) && (
          <Field label="Kâr hesabı (gelir)">
            {(id) => (
              <Combobox
                id={id}
                value={form.gainAccountId || null}
                options={combo(['income'])}
                onChange={(v) => set('gainAccountId', v)}
              />
            )}
          </Field>
        )}
        {gl.lt(0) && (
          <Field label="Zarar hesabı (gider)">
            {(id) => (
              <Combobox
                id={id}
                value={form.lossAccountId || null}
                options={combo(['expense', 'cost'])}
                onChange={(v) => set('lossAccountId', v)}
              />
            )}
          </Field>
        )}
        <Field label="Not">
          {(id) => (
            <Input
              id={id}
              value={form.note}
              maxLength={500}
              onChange={(e) => set('note', e.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
