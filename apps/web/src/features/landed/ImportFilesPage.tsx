import { CompanySavedViews } from '../../components/layout/CompanySavedViews';
import { ListToolbar } from '../../components/ui/ListTools';
import { Plus, Ship } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { ImportFileRow, ImportFileStatus } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { qtyText } from '../inventory/common';
import { ImportStatusBadge } from './common';

type Tab = 'files' | 'items' | 'recon';
const STATUSES: readonly ImportFileStatus[] = ['draft', 'allocated', 'posted', 'cancelled'];

/** İthalat dosyaları (Faz X4): liste ve kart bazında ithalat maliyeti raporu. */
export function ImportFilesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('invoices.manage');
  const [tab, setTab] = useState<Tab>('files');
  return (
    <>
      <PageHeader
        title={t('landed.title')}
        description={t('landed.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => navigate('/inventory/imports/new')}>
              <Plus className="size-4" aria-hidden />
              {t('landed.add')}
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Callout tone="warning">{t('landed.notice')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs id="landed-ImportFilesPage-0" panelId={() => 'landed-ImportFilesPage-0-panel'} value={tab} onChange={setTab} items={[{ key: 'files', label: t('landed.tabs.files') }, { key: 'items', label: t('landed.tabs.items') }, { key: 'recon', label: t('landed.tabs.recon') }]} />
      </div>
      <TabPanel id="landed-ImportFilesPage-0-panel" labelledBy={"landed-ImportFilesPage-0-" + (tab)}>
{tab === 'files' ? <FilesTab /> : tab === 'items' ? <ItemsTab /> : <ReconTab />}
</TabPanel>
    </>
  );
}

function FilesTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q.trim()) qs.set('q', q.trim());
  const { data, isPending, error: FilesTabQueryError, refetch: FilesTabQueryRetry, isFetching: FilesTabQueryFetching } = useCQuery<{ files: ImportFileRow[]; total: number }>(['import-files', qs.toString()], `/api/import-files?${qs}`);
  if (FilesTabQueryError && !data) return <ErrorState error={FilesTabQueryError} onRetry={() => void FilesTabQueryRetry()} retrying={FilesTabQueryFetching} />;
  return (
    <>
      <ListToolbar onReset={() => { setStatus(''); setQ(''); }}><CompanySavedViews page={'import-files'} filters={{ status }} onApply={view => { setStatus(view.status as typeof status); setQ(''); }} /></ListToolbar>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input aria-label={t('common.search')} placeholder={t('landed.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
        <Select aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">{t('common.all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`landed.status.${s}`)}
            </option>
          ))}
        </Select>
        <div className="ml-auto">
          <ExportMenu exportKey="import-files" params={{ status, q }} print={false} disabled={!data?.files.length} />
        </div>
      </div>
      {isPending ? (
        <PageLoading />
      ) : !data?.files.length ? (
        <Card>
          <EmptyState icon={<Ship className="size-5" />} title={t('landed.empty')} description={t('landed.emptyHint')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('landed.code')}</Th>
                <Th>{t('landed.name')}</Th>
                <Th>{t('landed.reference')}</Th>
                <Th>{t('landed.fileDate')}</Th>
                <Th>{t('common.status')}</Th>
                <Th num>{t('landed.lineCount')}</Th>
                <Th num>{t('landed.goodsValue')}</Th>
                <Th num>{t('landed.costTotal')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => (
                <Tr key={f.id}>
                  <Td className="font-mono text-[13px]">
                    <Link to={`/inventory/imports/${f.id}`} className="link">
                      {f.code}
                    </Link>
                  </Td>
                  <Td>{f.name}</Td>
                  <Td className="text-muted">{f.reference}</Td>
                  <Td>{formatDateTR(f.fileDate)}</Td>
                  <Td>
                    <ImportStatusBadge status={f.status} />
                  </Td>
                  <Td num>{f.lineCount}</Td>
                  <Td num>{money(f.goodsValue)}</Td>
                  <Td num>{money(f.costTotal)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}

interface ItemRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  fileCount: number;
  quantity: string;
  goodsValue: string;
  allocated: string;
  stocked: string;
  cogs: string;
  unitBefore: string | null;
  unitAfter: string | null;
}

function ItemsTab() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const { data, isPending, error: ItemsTabQueryError, refetch: ItemsTabQueryRetry, isFetching: ItemsTabQueryFetching } = useCQuery<{ items: ItemRow[] }>(['import-report', 'by-item'], '/api/import-files/reports/by-item');
  if (ItemsTabQueryError && !data) return <ErrorState error={ItemsTabQueryError} onRetry={() => void ItemsTabQueryRetry()} retrying={ItemsTabQueryFetching} />;
  return (
    <>
      <p className="mb-3 text-sm text-muted">{t('landed.itemsReport.hint')}</p>
      {isPending ? (
        <PageLoading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState title={t('landed.itemsReport.empty')} />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('landed.report.item')}</Th>
                  <Th num>{t('landed.itemsReport.files')}</Th>
                  <Th num>{t('landed.report.qty')}</Th>
                  <Th num>{t('landed.report.goods')}</Th>
                  <Th num>{t('landed.report.allocated')}</Th>
                  <Th num>{t('landed.report.before')}</Th>
                  <Th num>{t('landed.report.after')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <Tr key={i.itemId}>
                    <Td>
                      <span className="mr-2 font-mono text-xs text-muted">{i.itemCode}</span>
                      {i.itemName}
                    </Td>
                    <Td num>{i.fileCount}</Td>
                    <Td num>{qtyText(i.quantity)}</Td>
                    <Td num>{money(i.goodsValue)}</Td>
                    <Td num>{money(i.allocated)}</Td>
                    <Td num>{i.unitBefore ? money(i.unitBefore, 4) : ''}</Td>
                    <Td num>{i.unitAfter ? money(i.unitAfter, 4) : ''}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted">{base}</span>
            <ExportMenu exportKey="import-landed-items" print={false} />
          </div>
        </>
      )}
    </>
  );
}

type ReconData = {
  asOf: string;
  clearingAccount: { id: string; code: string; name: string } | null;
  clearingBalance: string | null;
  linked: { invoiceId: string; invoiceNo: string | null; partyName: string | null; files: string; costBase: string; invoiceNetBase: string; difference: string; matched: boolean }[];
  unlinkedCosts: { fileCode: string; description: string; amountBase: string }[];
  orphanInvoices: { invoiceId: string; invoiceNo: string | null; invoiceDate: string; partyName: string | null; amountBase: string }[];
  summary: { mismatched: number; unlinkedCosts: number; orphanInvoices: number; balanced: boolean };
};

/** Ek maliyet fark mutabakatı (öneri 51): dosya maliyeti ↔ fatura ↔ aktarım hesabı bakiyesi. */
function ReconTab() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const [asOf, setAsOf] = useState('');
  const qs = asOf ? `?asOf=${asOf}` : '';
  const { data, isPending, error, refetch, isFetching } = useCQuery<ReconData>(['import-report', 'reconciliation', asOf], `/api/import-files/reports/reconciliation${qs}`);
  if (error && !data) return <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t('landed.recon.hint')}</p>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted">{t('landed.recon.asOf')}</span>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label={t('landed.recon.asOf')} />
        </label>
      </div>
      {isPending || !data ? (
        <PageLoading />
      ) : (
        <>
          {!data.clearingAccount ? (
            <Callout tone="warning">{t('landed.recon.noClearing')}</Callout>
          ) : (
            <Card>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
                <span>
                  {t('landed.recon.clearing')}: <span className="font-mono">{data.clearingAccount.code}</span> {data.clearingAccount.name}
                </span>
                <span>
                  {t('landed.recon.balance')}: <strong className="tabular-nums">{money(data.clearingBalance ?? '0')} {base}</strong>
                </span>
                {data.summary.balanced ? <Badge tone="success" dot>{t('landed.recon.balanced')}</Badge> : <Badge tone="warning" dot>{t('landed.recon.unbalanced')}</Badge>}
              </div>
              {!data.summary.balanced && <p className="border-t border-border px-4 py-2 text-xs text-muted">{t('landed.recon.balanceHint')}</p>}
            </Card>
          )}
          <section aria-labelledby="landed-recon-linked">
            <h2 id="landed-recon-linked" className="mb-2 text-sm font-semibold">
              {t('landed.recon.linked')} {data.summary.mismatched > 0 && <Badge tone="danger">{t('landed.recon.mismatchCount', { count: data.summary.mismatched })}</Badge>}
            </h2>
            {!data.linked.length ? (
              <p className="text-sm text-muted">{t('landed.recon.none')}</p>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('landed.recon.invoice')}</Th>
                      <Th>{t('landed.recon.files')}</Th>
                      <Th num>{t('landed.recon.cost')}</Th>
                      <Th num>{t('landed.recon.invoiceNet')}</Th>
                      <Th num>{t('landed.recon.difference')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.linked.map((l) => (
                      <Tr key={l.invoiceId}>
                        <Td>
                          <Link className="link" to={`/invoices/${l.invoiceId}`}>{l.invoiceNo ?? '—'}</Link>
                          {l.partyName && <span className="ml-2 text-xs text-muted">{l.partyName}</span>}
                        </Td>
                        <Td>{l.files}</Td>
                        <Td num>{money(l.costBase)}</Td>
                        <Td num>{money(l.invoiceNetBase)}</Td>
                        <Td num>{l.matched ? <Badge tone="success" dot>{t('landed.recon.matched')}</Badge> : <span className="font-semibold text-danger">{money(l.difference)}</span>}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </section>
          <section aria-labelledby="landed-recon-unlinked">
            <h2 id="landed-recon-unlinked" className="mb-2 text-sm font-semibold">{t('landed.recon.unlinked')}</h2>
            {!data.unlinkedCosts.length ? (
              <p className="text-sm text-muted">{t('landed.recon.none')}</p>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('landed.code')}</Th>
                      <Th>{t('landed.recon.description')}</Th>
                      <Th num>{t('landed.recon.cost')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unlinkedCosts.map((u, i) => (
                      <Tr key={`${u.fileCode}-${i}`}>
                        <Td>{u.fileCode}</Td>
                        <Td>{u.description}</Td>
                        <Td num>{money(u.amountBase)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </section>
          <section aria-labelledby="landed-recon-orphans">
            <h2 id="landed-recon-orphans" className="mb-2 text-sm font-semibold">{t('landed.recon.orphans')}</h2>
            {!data.orphanInvoices.length ? (
              <p className="text-sm text-muted">{t('landed.recon.none')}</p>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('landed.recon.invoice')}</Th>
                      <Th>{t('landed.recon.date')}</Th>
                      <Th num>{t('landed.recon.amount')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orphanInvoices.map((o) => (
                      <Tr key={o.invoiceId}>
                        <Td>
                          <Link className="link" to={`/invoices/${o.invoiceId}`}>{o.invoiceNo ?? '—'}</Link>
                          {o.partyName && <span className="ml-2 text-xs text-muted">{o.partyName}</span>}
                        </Td>
                        <Td>{formatDateTR(o.invoiceDate)}</Td>
                        <Td num>{money(o.amountBase)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </section>
          <p className="text-xs text-muted">{t('landed.recon.footnote', { currency: base })}</p>
        </>
      )}
    </div>
  );
}
