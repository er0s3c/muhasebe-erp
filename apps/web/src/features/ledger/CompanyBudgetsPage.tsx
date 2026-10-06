import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, GitBranch, Check, ChartNoAxesCombined, Trash2, Printer } from 'lucide-react';
import {
  companyBudgetSchema,
  dec,
  todayIso,
  type CompanyBudget,
  type CompanyBudgetInput,
  type CompanyBudgetReport,
} from '@erp/shared';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Combobox } from '../../components/ui/Combobox';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet, Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Th, Td, Tr } from '../../components/ui/Table';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { useCQuery, useCMutation, useCan } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { useToast } from '../../components/ui/Toast';
import { money, formatDateTR } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import type { Account } from '../../lib/types';
import { useProjectOptions } from '../projects/common';

const months = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
];
const statuses = { draft: 'Taslak', approved: 'Onaylı', superseded: 'Eski revizyon' };
const invalidate = [['company-budgets'], ['company-budget-report'], ['activity-report']];
export function CompanyBudgetsPage() {
  return <BudgetContent key={useCompany().id} />;
}
function BudgetContent() {
  const can = useCan(),
    toast = useToast(),
    currency = useCompany().baseCurrency;
  const [params] = useSearchParams();
  const list = useCQuery<{ items: CompanyBudget[]; truncated: boolean }>(
    ['company-budgets'],
    '/api/company-budgets',
    { refetchOnWindowFocus: true },
  );
  const [selected, setSelected] = useState<string | null>(params.get('budget')),
    [form, setForm] = useState<CompanyBudget | 'new' | null>(null),
    [approval, setApproval] = useState<CompanyBudget | null>(null),
    [search, setSearch] = useState('');
  const currentId =
    selected ??
    list.data?.items.find((b) => b.status === 'approved')?.id ??
    list.data?.items[0]?.id ??
    null;
  const report = useCQuery<CompanyBudgetReport>(
    ['company-budget-report', currentId],
    currentId ? `/api/company-budgets/${currentId}` : null,
    { refetchOnWindowFocus: true },
  );
  const revise = useCMutation(
    (b: CompanyBudget, call) =>
      call<{ budget: CompanyBudget }>(`/api/company-budgets/${b.id}/revise`, { method: 'POST' }),
    invalidate,
  );
  const approve = useCMutation(
    (b: CompanyBudget, call) =>
      call(`/api/company-budgets/${b.id}/approve`, {
        method: 'POST',
        body: { version: b.version },
      }),
    invalidate,
  );
  const data = report.data,
    budget = data?.budget;
  const visible = (list.data?.items ?? []).filter((b) =>
    `${b.config.title} ${b.config.department} ${b.config.year}`
      .toLocaleLowerCase('tr-TR')
      .includes(search.toLocaleLowerCase('tr-TR')),
  );
  return (
    <>
      <PageHeader
        title="Bütçe ve sapma"
        description="Şirket ve departman planını aylık izleyin. Gerçekleşen tutarlar kayıtlı yevmiyelerden gelir; onaylı revizyon geçmişi korunur."
        actions={
          <>
            {can('ledger.post') && (
              <Button variant="primary" onClick={() => setForm('new')}>
                <Plus className="size-4" />
                Bütçe oluştur
              </Button>
            )}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer className="size-4" />
              Yazdır
            </Button>
          </>
        }
      />
      {list.error && <Callout tone="danger">{errorMessage(list.error)}</Callout>}
      {report.error && <Callout tone="danger">{errorMessage(report.error)}</Callout>}
      {revise.error && <Callout tone="danger">{errorMessage(revise.error)}</Callout>}
      {list.data?.truncated && <Callout>İlk 500 revizyon gösteriliyor.</Callout>}
      {list.isPending ? (
        <PageLoading />
      ) : !list.data?.items.length ? (
        <Card>
          <EmptyState
            icon={<ChartNoAxesCombined className="size-6" />}
            title="Bütçenizi oluşturun"
            description="Gelir ve gider hesaplarını seçin, aylık tutarları girin ve yönetici onayından sonra gerçekleşenleri karşılaştırın."
          />
        </Card>
      ) : (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="print:hidden overflow-hidden">
            <CardHeader
              title="Bütçe defteri"
              description={`${list.data.items.length} revizyon · ${currency}`}
            />
            <div className="p-4">
              <Input
                aria-label="Bütçe ara"
                placeholder="Başlık, departman veya yıl"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="max-h-[640px] overflow-y-auto divide-y divide-border">
              {visible.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={b.id === currentId}
                  onClick={() => setSelected(b.id)}
                  className={`w-full text-left p-4 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-text ${b.id === currentId ? 'bg-surface-2' : 'hover:bg-surface-2/60'}`}
                >
                  <div className="mb-2 flex flex-wrap gap-2">
                    <Badge
                      tone={
                        b.status === 'approved'
                          ? 'success'
                          : b.status === 'draft'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {statuses[b.status]}
                    </Badge>
                    <span className="text-xs text-muted">
                      {b.config.year} · R{b.revision}
                    </span>
                  </div>
                  <p className="break-words text-sm font-medium">{b.config.title}</p>
                  <p className="mt-1 text-xs text-muted">
                    {b.config.scope === 'company' ? 'Şirket geneli' : b.config.department}
                  </p>
                </button>
              ))}
              {!visible.length && (
                <p className="p-4 text-sm text-muted">Aramaya uygun bütçe yok.</p>
              )}
            </div>
          </Card>
          <div className="min-w-0 space-y-5">
            {report.isPending ? (
              <PageLoading />
            ) : (
              data &&
              budget && (
                <>
                  <Card className="overflow-hidden">
                    <CardHeader
                      title={budget.config.title}
                      description={`${budget.config.year} · Revizyon ${budget.revision} · ${statuses[budget.status]}`}
                      action={
                        <div className="flex flex-wrap gap-2">
                          <BudgetDownload data={data} />
                          {can('ledger.post') && budget.status === 'draft' && (
                            <Button size="sm" onClick={() => setForm(budget)}>
                              <Pencil className="size-4" />
                              Düzenle
                            </Button>
                          )}
                          {can('ledger.post') && budget.status === 'approved' && (
                            <Button
                              size="sm"
                              loading={revise.isPending}
                              onClick={() =>
                                revise.mutate(budget, {
                                  onSuccess: (r) => {
                                    setSelected(r.budget.id);
                                    setForm(r.budget);
                                    toast.success('Yeni taslak revizyon açıldı.');
                                  },
                                })
                              }
                            >
                              <GitBranch className="size-4" />
                              Revizyon aç
                            </Button>
                          )}
                          {can('ledger.post') &&
                            can('members.manage') &&
                            budget.status === 'draft' && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => setApproval(budget)}
                              >
                                <Check className="size-4" />
                                Onayla
                              </Button>
                            )}
                        </div>
                      }
                    />
                    <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
                      {[
                        { label: 'Yıllık gider bütçesi', value: data.totals.expense.planned },
                        {
                          label: `${formatDateTR(data.asOf)} itibarıyla gider`,
                          value: data.totals.expense.actual,
                        },
                        {
                          label: 'Yıllık gider bütçesine kalan',
                          value: dec(data.totals.expense.planned)
                            .minus(data.totals.expense.actual)
                            .toFixed(2),
                        },
                      ].map((s) => (
                        <div key={s.label} className="p-5">
                          <p className="text-xs text-muted">{s.label}</p>
                          <p className="mt-2 break-words font-mono text-xl tabular-nums">
                            {money(s.value)}
                            <span className="ml-2 text-xs text-muted">{currency}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="border-t border-border p-4 text-xs text-muted space-y-1">
                      <p>
                        Gelir: yıllık plan {money(data.totals.revenue.planned)} · gerçekleşen{' '}
                        {money(data.totals.revenue.actual)} {currency}. Net sonuç: plan{' '}
                        {money(data.totals.net.planned)} · gerçekleşen{' '}
                        {money(data.totals.net.actual)} {currency}.
                      </p>
                      <p>
                        Taslak yevmiyeler ve yıl sonu kapanış kayıtları dahil değildir. Ters
                        kayıtlar gerçekleşeni düzeltir. Yıllık kalan tutar, henüz gelmeyen ayların
                        bütçesini de içerir.
                      </p>
                      {budget.approvedAt && (
                        <p>
                          Onay: {budget.approverName} ·{' '}
                          {formatDateTR(budget.approvedAt.slice(0, 10))}
                        </p>
                      )}
                      {budget.config.notes && (
                        <p className="whitespace-pre-wrap">{budget.config.notes}</p>
                      )}
                    </div>
                  </Card>
                  {budget.status === 'draft' && (
                    <Callout>
                      Bu plan henüz onaylanmadı. Onaylanınca tutarlar sabitlenir; sonraki değişiklik
                      için yeni revizyon açılır.
                    </Callout>
                  )}
                  {budget.config.scope === 'department' && (
                    <Callout>
                      Departman kapsamı{' '}
                      {data.coverage.departmentMethod === 'projects'
                        ? `seçilen projelerdeki (${data.coverage.projectNames.join(', ')}) bütçe hesaplarının hareketleridir`
                        : 'seçilen muhasebe hesaplarının hareketleridir'}
                      . Kayıtlarda departman tahmini veya otomatik maliyet dağıtımı yapılmaz. Aynı
                      hareketi içeren ayrı bütçeler birbirine eklenmez.
                    </Callout>
                  )}
                  {data.coverage.unbudgetedAccountCount > 0 && (
                    <Callout tone="warning">
                      Bu kapsamda hareketi olup bütçeye alınmamış{' '}
                      {data.coverage.unbudgetedAccountCount} gelir/gider hesabı var. Tablodaki sonuç
                      yalnızca seçilen hesapları kapsar.
                    </Callout>
                  )}
                  <BudgetChart data={data} />
                  <BudgetTable data={data} />
                </>
              )
            )}
          </div>
        </div>
      )}
      {form && (
        <BudgetEditor
          budget={form === 'new' ? null : form}
          onClose={() => setForm(null)}
          onSaved={(id) => {
            setSelected(id);
            setForm(null);
          }}
        />
      )}
      <Modal
        open={!!approval}
        onOpenChange={(open) => !open && setApproval(null)}
        title="Bütçe revizyonunu onayla"
        footer={
          <>
            <Button onClick={() => setApproval(null)}>Vazgeç</Button>
            <Button
              variant="primary"
              loading={approve.isPending}
              onClick={() =>
                approval &&
                approve.mutate(approval, {
                  onSuccess: () => {
                    setApproval(null);
                    toast.success('Bütçe onaylandı.');
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Onayı kaydet
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {approval?.config.title} — R{approval?.revision} tutarları değişmez olarak saklanacak.
          Önceki onaylı revizyon varsa geçmişe alınacak.
        </p>
      </Modal>
    </>
  );
}
function BudgetChart({ data }: { data: CompanyBudgetReport }) {
  const [kind, setKind] = useState<'expense' | 'revenue'>('expense');
  const peak = data.months.reduce(
    (n, m) =>
      Math.max(
        n,
        Math.abs(Number(m[kind === 'expense' ? 'expensePlanned' : 'revenuePlanned'])),
        Math.abs(Number(m[kind === 'expense' ? 'expenseActual' : 'revenueActual'])),
      ),
    1,
  );
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Aylık plan ve gerçekleşen"
        description={`Plan çizgili, gerçekleşen düz çubuk · ${data.currency}`}
        action={
          <Select
            aria-label="Grafik türü"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="expense">Gider</option>
            <option value="revenue">Gelir</option>
          </Select>
        }
      />
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {data.months.map((m) => {
          const p = m[kind === 'expense' ? 'expensePlanned' : 'revenuePlanned'],
            a = m[kind === 'expense' ? 'expenseActual' : 'revenueActual'],
            future =
              `${data.budget.config.year}-${String(m.month).padStart(2, '0')}-01` > data.asOf;
          return (
            <div key={m.month} className="min-w-0">
              <div className="mb-2 flex justify-between gap-2 text-xs">
                <span>{months[m.month - 1]}</span>
                <span className="font-mono text-muted">
                  {future ? 'Henüz gelmedi' : `${money(a)} / ${money(p)}`}
                </span>
              </div>
              <div
                className="space-y-1.5"
                aria-label={`${months[m.month - 1]} plan ${money(p)}, gerçekleşen ${future ? 'henüz gelmedi' : money(a)} ${data.currency}`}
              >
                <div className="h-2 rounded bg-surface-2">
                  <div
                    className="h-full rounded border border-text/50 bg-text/10"
                    style={{ width: `${Math.min((Math.abs(Number(p)) / peak) * 100, 100)}%` }}
                  />
                </div>
                <div className="h-2 rounded bg-surface-2">
                  <div
                    className={`h-full rounded ${Number(a) > Number(p) && kind === 'expense' ? 'bg-danger' : 'bg-text'}`}
                    style={{
                      width: `${future ? 0 : Math.min((Math.abs(Number(a)) / peak) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
              {Number(a) < 0 && (
                <p className="mt-1 text-xs text-muted">
                  Negatif net hareket; grafik mutlak tutarı gösterir.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
function BudgetDownload({ data }: { data: CompanyBudgetReport }) {
  const company = useCompany(),
    toast = useToast(),
    [busy, setBusy] = useState<string | null>(null);
  async function download(format: 'xlsx' | 'csv') {
    setBusy(format);
    try {
      const { blob, filename } = await apiBlob(
        `/api/company-budgets/${data.budget.id}/export?format=${format}&asOf=${data.asOf}`,
        { companyId: company.id },
      );
      saveBlob(blob, filename ?? `budget.${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={!!busy}
        loading={busy === 'xlsx'}
        onClick={() => void download('xlsx')}
      >
        Excel
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!!busy}
        loading={busy === 'csv'}
        onClick={() => void download('csv')}
      >
        CSV
      </Button>
    </div>
  );
}
function BudgetTable({ data }: { data: CompanyBudgetReport }) {
  const [month, setMonth] = useState(Number(todayIso().slice(5, 7))),
    [source, setSource] = useState<{ accountId: string; label: string } | null>(null);
  const transactions = useCQuery<{
    items: {
      entryId: string;
      entryNo: string;
      date: string;
      description: string;
      debit: string;
      credit: string;
      projectName: string | null;
    }[];
    truncated: boolean;
  }>(
    ['company-budget-transactions', data.budget.id, source?.accountId, month],
    source
      ? `/api/company-budgets/${data.budget.id}/transactions?accountId=${source.accountId}&month=${month}&asOf=${data.asOf}`
      : null,
  );
  const future = `${data.budget.config.year}-${String(month).padStart(2, '0')}-01` > data.asOf;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Hesap bazında sapma"
        description={`Gerçekleşen − bütçe · ${data.currency}. Sıfır bütçede yüzde hesaplanmaz.`}
        action={
          <Select
            aria-label="Karşılaştırma ayı"
            value={month}
            onChange={(e) => {
              setMonth(Number(e.target.value));
              setSource(null);
            }}
          >
            {months.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
        }
      />
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>Hesap</Th>
              <Th>Tür</Th>
              <Th className="text-right">Bütçe</Th>
              <Th className="text-right">Gerçekleşen</Th>
              <Th className="text-right">Sapma</Th>
              <Th>Durum</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => {
              const m = l.months[month - 1]!;
              return (
                <Tr key={l.accountId}>
                  <Td>
                    <p className="font-mono text-xs text-muted">{l.code}</p>
                    <p>{l.name}</p>
                  </Td>
                  <Td>{l.kind === 'expense' ? 'Gider' : 'Gelir'}</Td>
                  <Td className="text-right font-mono">{money(m.planned)}</Td>
                  <Td className="text-right font-mono">{future ? '—' : money(m.actual)}</Td>
                  <Td className="text-right font-mono">
                    {future ? '—' : money(m.variance)}
                    {!future && (
                      <p className="text-xs text-muted">
                        {m.variancePct === null ? 'Oran yok' : `%${money(m.variancePct)}`}
                      </p>
                    )}
                  </Td>
                  <Td>
                    {future ? (
                      <Badge>Henüz gelmedi</Badge>
                    ) : (
                      <Badge tone={m.favorable ? 'success' : 'danger'}>
                        {m.variance === '0.00' ? 'Plana uygun' : m.favorable ? 'Olumlu' : 'Olumsuz'}
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setSource({ accountId: l.accountId, label: `${l.code} · ${l.name}` })
                      }
                    >
                      Kaynaklar
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableWrap>
      <Sheet
        open={!!source}
        onOpenChange={(open) => !open && setSource(null)}
        title="Gerçekleşenin kaynağı"
        description={`${source?.label ?? ''} · ${months[month - 1]} ${data.budget.config.year}`}
        wide
      >
        {transactions.isPending ? (
          <PageLoading />
        ) : transactions.error ? (
          <Callout tone="danger">{errorMessage(transactions.error)}</Callout>
        ) : (
          <>
            {transactions.data?.truncated && (
              <Callout>
                İlk 250 satır gösteriliyor; grafikte bütün hareketler hesaba katılmıştır.
              </Callout>
            )}
            {!transactions.data?.items.length ? (
              <EmptyState
                title="Bu ay kayıtlı hareket yok"
                description="Taslak yevmiyeler gerçekleşene girmez."
              />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Tarih / kayıt</Th>
                      <Th>Açıklama</Th>
                      <Th className="text-right">Borç</Th>
                      <Th className="text-right">Alacak</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.data.items.map((r, i) => (
                      <Tr key={`${r.entryId}:${i}`}>
                        <Td>
                          <p>{formatDateTR(r.date)}</p>
                          <Link className="link" to={`/accounting/journal/${r.entryId}`}>
                            {r.entryNo}
                          </Link>
                        </Td>
                        <Td>
                          <p>{r.description}</p>
                          <p className="text-xs text-muted">{r.projectName}</p>
                        </Td>
                        <Td className="text-right font-mono">{money(r.debit)}</Td>
                        <Td className="text-right font-mono">{money(r.credit)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </>
        )}
      </Sheet>
    </Card>
  );
}
function BudgetEditor({
  budget,
  onClose,
  onSaved,
}: {
  budget: CompanyBudget | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast(),
    currency = useCompany().baseCurrency;
  const [config, setConfig] = useState<CompanyBudgetInput>(
      budget?.config ?? {
        title: '',
        year: Number(todayIso().slice(0, 4)),
        scope: 'company',
        department: '',
        projectIds: [],
        notes: '',
        lines: [],
      },
    ),
    [accountId, setAccountId] = useState('');
  const accounts = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts'),
    projects = useProjectOptions(config.scope === 'department');
  const change = <K extends keyof CompanyBudgetInput>(key: K, value: CompanyBudgetInput[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));
  const changeLine = (index: number, next: Partial<CompanyBudgetInput['lines'][number]>) =>
    change(
      'lines',
      config.lines.map((l, i) => (i === index ? { ...l, ...next } : l)),
    );
  const save = useCMutation(
    (input: CompanyBudgetInput, call) =>
      call<{ budget: CompanyBudget }>(
        budget ? `/api/company-budgets/${budget.id}` : '/api/company-budgets',
        {
          method: budget ? 'PUT' : 'POST',
          body: budget ? { config: input, version: budget.version } : input,
        },
      ),
    invalidate,
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={budget ? `Bütçeyi düzenle · R${budget.revision}` : 'Bütçe oluştur'}
      description="Aylık tutarlar defter para birimindedir. Bu ekran muhasebe kaydı oluşturmaz."
      wide
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!companyBudgetSchema.safeParse(config).success}
            onClick={() =>
              save.mutate(companyBudgetSchema.parse(config), {
                onSuccess: (r) => {
                  toast.success('Bütçe taslağı kaydedildi.');
                  onSaved(r.budget.id);
                },
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            Taslağı kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bütçe başlığı" required>
            {(id) => (
              <Input
                id={id}
                value={config.title}
                maxLength={150}
                onChange={(e) => change('title', e.target.value)}
              />
            )}
          </Field>
          <Field label="Bütçe yılı" required>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1900}
                max={2100}
                disabled={!!budget}
                value={config.year}
                onChange={(e) => change('year', Number(e.target.value))}
              />
            )}
          </Field>
          <Field label="Bütçe kapsamı">
            {(id) => (
              <Select
                id={id}
                disabled={!!budget}
                value={config.scope}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    scope: e.target.value as typeof c.scope,
                    department: '',
                    projectIds: [],
                  }))
                }
              >
                <option value="company">Şirket</option>
                <option value="department">Departman</option>
              </Select>
            )}
          </Field>
          {config.scope === 'department' && (
            <Field label="Departman adı" required>
              {(id) => (
                <Input
                  id={id}
                  disabled={!!budget}
                  value={config.department}
                  maxLength={100}
                  onChange={(e) => change('department', e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
        {config.scope === 'department' && (
          <>
            <Callout>
              Departmana özel muhasebe hesaplarını seçin. İsterseniz proje süzgeci ekleyin; boş
              bırakırsanız seçilen hesapların tüm şirket hareketleri karşılaştırılır. Departman adı
              tek başına hareket süzmez.
            </Callout>
            {projects.allowed && (
              <fieldset className="rounded-xl border border-border p-4">
                <legend className="px-2 text-sm">Kapsamdaki projeler (isteğe bağlı)</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {projects.projects.map((p) => (
                    <label key={p.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-text"
                        checked={config.projectIds.includes(p.id)}
                        onChange={(e) =>
                          change(
                            'projectIds',
                            e.target.checked
                              ? [...config.projectIds, p.id]
                              : config.projectIds.filter((id) => id !== p.id),
                          )
                        }
                      />
                      {p.code} — {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}
        <Field label="Plan notu">
          {(id) => (
            <Textarea
              id={id}
              value={config.notes}
              maxLength={2000}
              onChange={(e) => change('notes', e.target.value)}
            />
          )}
        </Field>
        <div className="rounded-xl border border-border p-4 space-y-3">
          <p className="text-sm">
            Gelir / gider hesabı ekle{' '}
            <span className="text-xs text-muted">
              ({config.lines.length}/150 · {currency})
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-0 flex-1 basis-60">
              <Combobox
                aria-label="Bütçe hesabı"
                value={accountId}
                onChange={setAccountId}
                options={(accounts.data?.accounts ?? [])
                  .filter(
                    (a) =>
                      a.isPostable &&
                      a.isActive &&
                      !a.partyControl &&
                      !config.lines.some((l) => l.accountId === a.id),
                  )
                  .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
              />
            </div>
            <Button
              disabled={!accountId || config.lines.length >= 150}
              onClick={() => {
                change('lines', [
                  ...config.lines,
                  { accountId, kind: 'expense', amounts: Array(12).fill('0') },
                ]);
                setAccountId('');
              }}
            >
              <Plus className="size-4" />
              Hesap ekle
            </Button>
          </div>
        </div>
        {config.lines.map((line, index) => {
          const account = accounts.data?.accounts.find((a) => a.id === line.accountId);
          return (
            <Card key={line.accountId} className="overflow-hidden">
              <CardHeader
                title={account ? `${account.code} · ${account.name}` : 'Hesap'}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${account?.code ?? index + 1} hesabını kaldır`}
                    onClick={() =>
                      change(
                        'lines',
                        config.lines.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                }
              />
              <div className="space-y-4 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={`${account?.code ?? index + 1} hesap yönü`}
                    hint="Gider: borç − alacak. Gelir: alacak − borç."
                  >
                    {(id) => (
                      <Select
                        id={id}
                        value={line.kind}
                        onChange={(e) =>
                          changeLine(index, { kind: e.target.value as typeof line.kind })
                        }
                      >
                        <option value="expense">Gider</option>
                        <option value="revenue">Gelir</option>
                      </Select>
                    )}
                  </Field>
                  <Field
                    label={`${account?.code ?? index + 1} eşit aylık tutar`}
                    hint="Girilen tutar 12 aya da uygulanır."
                  >
                    {(id) => (
                      <MoneyInput
                        id={id}
                        value={
                          line.amounts.every((a) => a === line.amounts[0]) ? line.amounts[0]! : '0'
                        }
                        onChange={(value) => changeLine(index, { amounts: Array(12).fill(value) })}
                      />
                    )}
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {months.map((m, i) => (
                    <Field key={m} label={`${account?.code ?? index + 1} ${m}`}>
                      {(id) => (
                        <MoneyInput
                          id={id}
                          value={line.amounts[i]!}
                          onChange={(value) =>
                            changeLine(index, {
                              amounts: line.amounts.map((a, j) => (j === i ? value : a)),
                            })
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
                <p className="text-right text-xs text-muted">
                  Yıllık plan:{' '}
                  {line.amounts.every((a) => /^\d+(\.\d+)?$/.test(a))
                    ? money(line.amounts.reduce((s, a) => s.plus(a), dec(0)).toFixed(2))
                    : '—'}{' '}
                  {currency}
                </p>
              </div>
            </Card>
          );
        })}
        {!config.lines.length && (
          <p className="text-sm text-muted">Kaydetmek için en az bir hesap ekleyin.</p>
        )}
      </div>
    </Sheet>
  );
}
