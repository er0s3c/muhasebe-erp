import { ArrowLeftRight, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { STOCK_DOC_TYPES } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { StockDocListRow, StockDocType } from '../../lib/types';
import { DocTypeBadge, useWarehouses } from './common';
import { MovementDetailSheet } from './MovementDetailSheet';
import { MovementFormSheet } from './MovementFormSheet';

const PAGE = 100;

export function MovementsPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const canMove = useCan()('inventory.move');
  const { data: wh } = useWarehouses();
  const [type, setType] = useState<StockDocType | ''>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => setLimit(PAGE), [type, warehouseId, from, to]);

  const qs = new URLSearchParams({ limit: String(limit) });
  if (type) qs.set('type', type);
  if (warehouseId) qs.set('warehouseId', warehouseId);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const { data, isPending } = useCQuery<{ documents: StockDocListRow[]; total: number }>(['stock-docs', 'list', qs.toString()], `/api/stock-documents?${qs}`);
  const filtered = !!(type || warehouseId || from || to);

  return (
    <>
      <PageHeader
        title={t('inventory.movements.title')}
        description={t('inventory.movements.subtitle')}
        actions={
          canMove && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              {t('inventory.movements.add')}
            </Button>
          )
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <Select className="w-48" value={type} onChange={(e) => setType(e.target.value as StockDocType | '')} aria-label={t('inventory.movements.type')}>
          <option value="">{t('inventory.movements.allTypes')}</option>
          {STOCK_DOC_TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`inventory.docTypes.${k}`)}
            </option>
          ))}
        </Select>
        <Select className="w-48" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label={t('inventory.movements.warehouse')}>
          <option value="">{t('inventory.movements.allWarehouses')}</option>
          {wh?.warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.documents.length ? (
        <Card>
          <EmptyState
            icon={<ArrowLeftRight className="size-5" />}
            title={filtered ? t('common.noResults') : t('inventory.movements.empty')}
            description={filtered ? undefined : t('inventory.movements.emptyDesc')}
            action={
              canMove && !filtered ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t('inventory.movements.add')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-40">{t('inventory.movements.no')}</Th>
                  <Th className="w-40">{t('inventory.movements.type')}</Th>
                  <Th>{t('inventory.movements.warehouse')}</Th>
                  <Th num>{t('inventory.movements.lines')}</Th>
                  <Th num>
                    {t('inventory.movements.value')} ({company.baseCurrency})
                  </Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => (
                  <Tr
                    key={d.id}
                    clickable
                    tabIndex={0}
                    onClick={() => setOpenId(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setOpenId(d.id);
                    }}
                  >
                    <Td className="whitespace-nowrap">{formatDateTR(d.docDate)}</Td>
                    <Td className="whitespace-nowrap font-mono text-[13px]">{d.docNo}</Td>
                    <Td>
                      <DocTypeBadge type={d.type} />
                    </Td>
                    <Td>
                      <span>
                        {d.warehouseName}
                        {d.toWarehouseName && ` → ${d.toWarehouseName}`}
                      </span>
                      {d.reversalOfId && <Badge className="ml-2">{t('inventory.movements.reversal')}</Badge>}
                      {d.reversedById && <Badge tone="danger" className="ml-2">{t('inventory.movements.reversed')}</Badge>}
                      {d.description && <span className="block truncate text-xs text-muted">{d.description}</span>}
                    </Td>
                    <Td num className="text-muted">{d.lineCount}</Td>
                    <Td num>{money(d.totalValue)}</Td>
                    <Td>
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <div className="mt-3 text-sm text-muted">{t('inventory.movements.total', { count: data.total })}</div>
          {data.documents.length < data.total && (
            <div className="mt-3 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}

      <MovementFormSheet open={adding} onOpenChange={setAdding} onSaved={(doc) => setOpenId(doc.document.id)} />
      <MovementDetailSheet id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />
    </>
  );
}
