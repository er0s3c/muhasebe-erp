import { Plus, Ship } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { ImportFileRow, ImportFileStatus } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { qtyText } from '../inventory/common';
import { ImportStatusBadge } from './common';

type Tab = 'files' | 'items';
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
        <SegmentedTabs value={tab} onChange={setTab} items={[{ key: 'files', label: t('landed.tabs.files') }, { key: 'items', label: t('landed.tabs.items') }]} />
      </div>
      {tab === 'files' ? <FilesTab /> : <ItemsTab />}
    </>
  );
}

function FilesTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q.trim()) qs.set('q', q.trim());
  const { data, isPending } = useCQuery<{ files: ImportFileRow[]; total: number }>(['import-files', qs.toString()], `/api/import-files?${qs}`);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input aria-label={t('common.search')} placeholder={t('landed.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} className="w-72" />
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
  const { data, isPending } = useCQuery<{ items: ItemRow[] }>(['import-report', 'by-item'], '/api/import-files/reports/by-item');
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
