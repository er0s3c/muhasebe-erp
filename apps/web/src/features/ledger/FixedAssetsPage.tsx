import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Package, History, Pencil, Archive, Calculator } from 'lucide-react';
import {
  fixedAssetSchema,
  depreciationForMonth,
  todayIso,
  dec,
  type FixedAssetInput,
  type FixedAsset,
  type DepreciationEntry,
} from '@erp/shared';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Combobox } from '../../components/ui/Combobox';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Sheet, Modal } from '../../components/ui/Sheet';
import { TableWrap, Table, Th, Td, Tr } from '../../components/ui/Table';
import { useCan, useCQuery, useCMutation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { money, formatDateTR } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { useToast } from '../../components/ui/Toast';
import type { Account } from '../../lib/types';
import { useProjectOptions } from '../projects/common';

const invalidate = [
  ['fixed-assets'],
  ['journal'],
  ['journal-entry'],
  ['reports'],
  ['dashboard'],
  ['projects'],
];
const categories = {
  equipment: 'İş makinesi / ekipman',
  vehicle: 'Araç',
  building: 'Bina',
  furniture: 'Demirbaş',
  other: 'Diğer',
};
const blank = (): FixedAssetInput => ({
  code: '',
  name: '',
  category: 'equipment',
  acquisitionDate: todayIso(),
  startMonth: todayIso().slice(0, 7),
  cost: '',
  salvage: '0',
  usefulMonths: 60,
  expenseAccountId: '',
  accumulatedAccountId: '',
  projectId: null,
  department: '',
  serialNo: '',
  location: '',
  notes: '',
});
export function FixedAssetsPage() {
  return <AssetContent key={useCompany().id} />;
}
function AssetContent() {
  const base = useCompany().baseCurrency,
    can = useCan(),
    toast = useToast();
  const [params] = useSearchParams();
  const query = useCQuery<{ items: FixedAsset[]; truncated: boolean }>(
    ['fixed-assets'],
    '/api/fixed-assets',
    { refetchOnWindowFocus: true },
  );
  const [form, setForm] = useState<{ config: FixedAssetInput; asset: FixedAsset | null } | null>(
      null,
    ),
    [selected, setSelected] = useState<string | null>(params.get('asset')),
    [search, setSearch] = useState(''),
    [department, setDepartment] = useState('');
  const active = useCMutation(
    (v: FixedAsset, call) =>
      call(`/api/fixed-assets/${v.id}/active`, {
        method: 'PATCH',
        body: { active: !v.active, version: v.version },
      }),
    invalidate,
  );
  const rows = (query.data?.items ?? []).filter(
    (a) =>
      (!department || a.config.department === department) &&
      `${a.config.code} ${a.config.name} ${a.config.serialNo} ${a.config.location}`
        .toLocaleLowerCase('tr-TR')
        .includes(search.toLocaleLowerCase('tr-TR')),
  );
  const departments = [
    ...new Set((query.data?.items ?? []).map((a) => a.config.department).filter(Boolean)),
  ].sort();
  const total = (key: 'cost' | 'postedAmount' | 'draftAmount' | 'bookValue') =>
    rows.reduce((s, a) => s.plus(key === 'cost' ? a.config.cost : a[key]), dec(0)).toFixed(2);
  return (
    <>
      <PageHeader
        title="Demirbaş ve amortisman"
        description="İş makineleri, araçlar ve demirbaşların maliyeti, aylık amortismanı ve defter değeri."
        actions={
          can('ledger.post') && (
            <Button variant="primary" onClick={() => setForm({ config: blank(), asset: null })}>
              <Plus className="size-4" />
              Demirbaş ekle
            </Button>
          )
        }
      />
      <div className="mb-5 grid divide-y divide-border rounded-2xl border border-border bg-surface sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4">
        {(
          [
            ['Maliyet', total('cost')],
            ['Kaydedilen amortisman', total('postedAmount')],
            ['Taslak amortisman', total('draftAmount')],
            ['Defter değeri', total('bookValue')],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="px-5 py-4">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-xl tabular-nums">
              {money(value)} <span className="text-xs text-muted">{base}</span>
            </p>
          </div>
        ))}
      </div>
      <Callout tone="info">
        Düz çizgi hesabı, girdiğiniz maliyet, kalıntı değer ve kullanım süresini kullanır. Edinim
        kaydı ayrıca yapılır; bu kart satın alma yevmiyesi oluşturmaz. Amortisman önce taslaktır ve
        muhasebe ekranında kaydedilir.
      </Callout>
      <div className="my-4 flex flex-wrap items-end gap-3">
        <Field label="Demirbaş ara">
          {(id) => (
            <Input
              id={id}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ad, kod, seri no, konum"
            />
          )}
        </Field>
        <Field label="Departman filtresi">
          {(id) => (
            <Select id={id} value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Tüm departmanlar</option>
              {departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {query.isPending ? (
        <PageLoading />
      ) : query.error ? (
        <Callout tone="danger">{errorMessage(query.error)}</Callout>
      ) : !rows.length ? (
        <Card>
          <EmptyState
            icon={<Package />}
            title="Demirbaş bulunamadı"
            description="İlk kartı ekleyerek maliyet ve amortisman planını oluşturun."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((a) => (
            <Card key={a.id}>
              <CardHeader
                title={a.config.name}
                description={`${a.config.code} · ${categories[a.config.category]}`}
                action={
                  <Badge tone={a.active ? 'success' : 'neutral'}>
                    {a.active ? 'Aktif' : 'Pasif'}
                  </Badge>
                }
              />
              <div className="space-y-4 p-5">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted">Maliyet</p>
                    <p className="mt-1 tabular-nums">
                      {money(a.config.cost)} {base}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Defter değeri</p>
                    <p className="mt-1 tabular-nums">
                      {money(a.bookValue)} {base}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Amortisman planı</p>
                    <p className="mt-1">
                      {a.config.startMonth} · {a.config.usefulMonths} ay
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Departman / konum</p>
                    <p className="mt-1 break-words">
                      {[a.config.department, a.config.location].filter(Boolean).join(' · ') ||
                        'Belirtilmedi'}
                    </p>
                  </div>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-surface-2"
                  aria-label={`${a.config.name} amortisman ilerlemesi`}
                >
                  <div
                    className="h-full bg-brand"
                    style={{
                      width: `${Math.max(0, Math.min(100, dec(a.postedAmount).div(a.config.cost).times(100).toNumber()))}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted">
                  Kaydedilen {money(a.postedAmount)} {base} · Taslak {money(a.draftAmount)} {base}
                  {a.config.serialNo ? ` · Seri ${a.config.serialNo}` : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setSelected(a.id)}>
                    <History className="size-4" />
                    Plan ve geçmiş
                  </Button>
                  {can('ledger.post') && (
                    <>
                      {!a.historyCount && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setForm({ config: a.config, asset: a })}
                        >
                          <Pencil className="size-4" />
                          Düzenle
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={active.isPending}
                        onClick={() =>
                          active.mutate(a, { onError: (e) => toast.error(errorMessage(e)) })
                        }
                      >
                        <Archive className="size-4" />
                        {a.active ? 'Pasifleştir' : 'Etkinleştir'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {query.data?.truncated && (
        <p className="mt-3 text-sm text-muted">İlk 1.000 kart gösteriliyor.</p>
      )}
      {form && <AssetForm initial={form.config} asset={form.asset} onClose={() => setForm(null)} />}
      {selected && <AssetHistory id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
function AssetForm({
  initial,
  asset,
  onClose,
}: {
  initial: FixedAssetInput;
  asset: FixedAsset | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial),
    [error, setError] = useState<string | null>(null),
    toast = useToast(),
    base = useCompany().baseCurrency;
  const accounts = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts'),
    projects = useProjectOptions();
  const options = (accounts.data?.accounts ?? []).filter(
    (a) =>
      a.isActive && a.isPostable && !a.partyControl && (!a.currencyCode || a.currencyCode === base),
  );
  const combo = (list: Account[]) =>
    list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const save = useCMutation(
    (config: FixedAssetInput, call) =>
      call(asset ? `/api/fixed-assets/${asset.id}` : '/api/fixed-assets', {
        method: asset ? 'PUT' : 'POST',
        body: asset ? { config, version: asset.version } : config,
      }),
    invalidate,
  );
  const set = <K extends keyof FixedAssetInput>(key: K, value: FixedAssetInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const submit = () => {
    const parsed = fixedAssetSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Alanları kontrol edin.');
      return;
    }
    setError(null);
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Demirbaş kaydedildi.');
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={asset ? 'Demirbaş düzenle' : 'Yeni demirbaş'}
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Kartı kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Demirbaş kodu">
            {(id) => (
              <Input
                id={id}
                value={form.code}
                maxLength={40}
                onChange={(e) => set('code', e.target.value)}
              />
            )}
          </Field>
          <Field label="Kategori">
            {(id) => (
              <Select
                id={id}
                value={form.category}
                onChange={(e) => set('category', e.target.value as FixedAssetInput['category'])}
              >
                {Object.entries(categories).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Demirbaş adı">
          {(id) => (
            <Input
              id={id}
              value={form.name}
              maxLength={160}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Edinim tarihi">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.acquisitionDate}
                onChange={(e) => set('acquisitionDate', e.target.value)}
              />
            )}
          </Field>
          <Field label="Amortisman başlangıç ayı">
            {(id) => (
              <Input
                id={id}
                type="month"
                value={form.startMonth}
                onChange={(e) => set('startMonth', e.target.value)}
              />
            )}
          </Field>
          <Field label={`Maliyet (${base})`}>
            {(id) => <MoneyInput id={id} value={form.cost} onChange={(v) => set('cost', v)} />}
          </Field>
          <Field label={`Kalıntı değer (${base})`}>
            {(id) => (
              <MoneyInput id={id} value={form.salvage} onChange={(v) => set('salvage', v)} />
            )}
          </Field>
        </div>
        <Field
          label="Kullanım süresi (ay)"
          hint="Bu süre kullanıcı varsayımıdır; uygulama yasal amortisman oranı seçmez."
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={600}
              value={form.usefulMonths}
              onChange={(e) => set('usefulMonths', Number(e.target.value))}
            />
          )}
        </Field>
        <Field label="Amortisman gider hesabı">
          {(id) => (
            <Combobox
              id={id}
              value={form.expenseAccountId || null}
              options={combo(options.filter((a) => ['expense', 'cost', 'income'].includes(a.type)))}
              onChange={(v) => set('expenseAccountId', v)}
            />
          )}
        </Field>
        <Field label="Birikmiş amortisman hesabı">
          {(id) => (
            <Combobox
              id={id}
              value={form.accumulatedAccountId || null}
              options={combo(options.filter((a) => a.type === 'asset'))}
              onChange={(v) => set('accumulatedAccountId', v)}
            />
          )}
        </Field>
        {projects.allowed && (
          <Field label="Maliyet projesi">
            {(id) => (
              <Select
                id={id}
                value={form.projectId ?? ''}
                onChange={(e) => set('projectId', e.target.value || null)}
              >
                <option value="">Projesiz</option>
                {projects.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {(['department', 'serialNo', 'location'] as const).map((k) => (
            <Field
              key={k}
              label={{ department: 'Departman', serialNo: 'Seri numarası', location: 'Konum' }[k]}
            >
              {(id) => (
                <Input
                  id={id}
                  value={form[k]}
                  maxLength={k === 'location' ? 160 : 100}
                  onChange={(e) => set(k, e.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
        <Field label="Notlar">
          {(id) => (
            <Textarea
              id={id}
              value={form.notes}
              maxLength={1000}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
function AssetHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useCQuery<{ asset: FixedAsset; history: DepreciationEntry[] }>(
    ['fixed-assets', id],
    `/api/fixed-assets/${id}`,
    { refetchOnWindowFocus: true },
  );
  const [month, setMonth] = useState(todayIso().slice(0, 7)),
    [cancel, setCancel] = useState<DepreciationEntry | null>(null),
    [reason, setReason] = useState(''),
    [cancelDate, setCancelDate] = useState(todayIso()),
    toast = useToast(),
    can = useCan(),
    base = useCompany().baseCurrency;
  const generate = useCMutation(
    (version: number, call) =>
      call<{ created: boolean; entry: DepreciationEntry }>(`/api/fixed-assets/${id}/depreciation`, {
        method: 'POST',
        body: { month, version },
      }),
    invalidate,
  );
  const cancelMut = useCMutation(
    (entry: DepreciationEntry, call) =>
      call(`/api/fixed-assets/${id}/depreciation/${entry.id}/cancel`, {
        method: 'POST',
        body: { reason, date: cancelDate },
      }),
    invalidate,
  );
  const data = query.data,
    preview = data ? depreciationForMonth(data.asset.config, month) : null;
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={data?.asset.config.name ?? 'Amortisman planı'}
    >
      {query.isPending ? (
        <PageLoading />
      ) : query.error ? (
        <Callout tone="danger">{errorMessage(query.error)}</Callout>
      ) : (
        data && (
          <div className="space-y-5">
            <p className="text-sm text-muted">
              {data.asset.config.code} · {data.asset.config.usefulMonths} ay · Kalıntı değer{' '}
              {money(data.asset.config.salvage)} {base}
            </p>
            <div className="rounded-xl border border-border p-4">
              <Field label="Amortisman ayı">
                {(field) => (
                  <Input
                    id={field}
                    type="month"
                    value={month}
                    max={todayIso().slice(0, 7)}
                    onChange={(e) => setMonth(e.target.value)}
                  />
                )}
              </Field>
              {preview ? (
                <div className="my-4 space-y-1 text-sm">
                  <p>
                    Aylık tutar:{' '}
                    <strong>
                      {money(preview.amount)} {base}
                    </strong>
                  </p>
                  <p className="text-muted">
                    Plandaki birikmiş tutar: {money(preview.plannedAccumulated)} {base}
                  </p>
                </div>
              ) : (
                <p className="my-3 text-sm text-muted">Bu ay kullanım süresi dışında.</p>
              )}
              {can('ledger.post') && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!preview || !data.asset.active || month > todayIso().slice(0, 7)}
                  loading={generate.isPending}
                  onClick={() =>
                    generate.mutate(data.asset.version, {
                      onSuccess: (r) =>
                        toast.success(
                          r.created
                            ? 'Amortisman taslağı oluşturuldu.'
                            : 'Bu ayın kaydı zaten mevcut.',
                        ),
                      onError: (e) => toast.error(errorMessage(e)),
                    })
                  }
                >
                  <Calculator className="size-4" />
                  Yevmiye taslağı oluştur
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">
              Plan tutarı tüm ayların hesaplanan toplamıdır. Defter değeri yalnızca kaydedilmiş ve
              iptal edilmemiş yevmiyelerden gelir. İptal edilen taslak muhasebeleştirilemez.
            </p>
            {!data.history.length ? (
              <EmptyState title="Henüz amortisman kaydı yok" />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Dönem</Th>
                      <Th num>Tutar ({base})</Th>
                      <Th>Durum / kaynak</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((e) => (
                      <Tr key={e.id}>
                        <Td>{e.month}</Td>
                        <Td num>{money(e.amount)}</Td>
                        <Td>
                          <Badge
                            tone={
                              e.cancelledAt
                                ? 'danger'
                                : e.entryStatus === 'posted'
                                  ? 'success'
                                  : 'warning'
                            }
                          >
                            {e.cancelledAt
                              ? 'İptal'
                              : e.entryStatus === 'posted'
                                ? 'Kayıtlı'
                                : 'Taslak'}
                          </Badge>
                          <Link
                            className="link mt-1 block text-xs"
                            to={`/accounting/journal?open=${e.journalEntryId}`}
                          >
                            {e.entryNo ?? 'Yevmiyeyi aç'}
                          </Link>
                          {e.reversalEntryId && (
                            <Link
                              className="link mt-1 block text-xs"
                              to={`/accounting/journal?open=${e.reversalEntryId}`}
                            >
                              Ters yevmiye
                            </Link>
                          )}
                          {e.cancelledAt && (
                            <p className="mt-1 text-xs text-muted">
                              {formatDateTR(e.cancelledAt.slice(0, 10))}
                            </p>
                          )}
                        </Td>
                        <Td>
                          {can('ledger.post') && !e.cancelledAt && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setReason('');
                                setCancelDate(e.entryDate > todayIso() ? e.entryDate : todayIso());
                                setCancel(e);
                              }}
                            >
                              İptal et
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </div>
        )
      )}
      <Modal
        open={!!cancel}
        onOpenChange={(o) => !o && setCancel(null)}
        title="Amortismanı iptal et"
        footer={
          <>
            <Button onClick={() => setCancel(null)}>Vazgeç</Button>
            <Button
              variant="primary"
              disabled={
                reason.trim().length < 3 ||
                !cancelDate ||
                (cancel?.entryStatus === 'posted' && cancelDate < cancel.entryDate)
              }
              loading={cancelMut.isPending}
              onClick={() =>
                cancel &&
                cancelMut.mutate(cancel, {
                  onSuccess: () => {
                    toast.success('Amortisman iptal edildi.');
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
            Kayıtlı yevmiye ters kayıtla nötrlenir. Taslak iptali mali hareket oluşturmaz.
          </p>
          <Field label="İptal gerekçesi">
            {(field) => (
              <Input
                id={field}
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          {cancel?.entryStatus === 'posted' && (
            <Field label="Ters yevmiye tarihi">
              {(field) => (
                <Input
                  id={field}
                  type="date"
                  min={cancel.entryDate}
                  value={cancelDate}
                  onChange={(e) => setCancelDate(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      </Modal>
    </Sheet>
  );
}
