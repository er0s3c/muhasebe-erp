import { useTranslation } from 'react-i18next';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { currencySymbol, formatDateTR, isZero, money, moneyIn } from '../../lib/format';
import type { ConsolidatedReportData, StatementLine } from '../../lib/types';
import { ExcludedNotice } from '../reports/FxPositionView';

const neg = (v: string) => (Number(v) < 0 ? 'text-danger' : undefined);

function StatementTable({ title, lines, data, testId }: { title: string; lines: StatementLine[]; data: ConsolidatedReportData; testId: string }) {
  const { t } = useTranslation();
  const g = data.group.reportingCurrency;
  const cols = [...data.companies.map((c) => ({ id: c.id, name: c.name })), { id: 'consolidated', name: t('consolidation.consolidated') }];
  return (
    <Card className="p-5" data-testid={testId}>
      <CardHeader title={title} description={t('consolidation.statementNote')} />
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('consolidation.item')}</Th>
              {cols.map((c) => <Th key={c.id} num>{c.name} ({g})</Th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <Tr key={l.key} data-testid={`line-${l.key}`} className={cn(l.kind === 'total' && 'bg-surface-2', l.kind === 'subtotal' && 'bg-surface-2/60')}>
                <Td className={cn(l.kind === 'detail' && 'pl-8 text-muted')}>{l.label}</Td>
                {cols.map((c) => <Td key={c.id} num className={neg(l.values[c.id] ?? '0')}>{money(l.values[c.id] ?? '0')}</Td>)}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </Card>
  );
}

/** Konsolide mizan + bilanço + gelir tablosu görünümü (şirket sütunları + eliminasyon + konsolide). */
export function ConsolidatedReportView({ data }: { data: ConsolidatedReportData }) {
  const { t } = useTranslation();
  const g = data.group.reportingCurrency;
  const diffLarge = Object.values(data.translationDiff).some((v) => !isZero(v));
  return (
    <div className="flex flex-col gap-5" data-testid="consolidated-report">
      <ExcludedNotice excluded={data.excluded} />
      <UnverifiedNote />
      <Card className="p-5">
        <CardHeader title={t('consolidation.ratesTitle')} description={t('consolidation.ratesDesc', { closing: formatDateTR(data.period.closingDate) })} />
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('consolidation.company')}</Th>
                <Th>{t('consolidation.baseCurrency')}</Th>
                <Th num>{t('consolidation.closingRate', { cur: g })}</Th>
                <Th>{t('consolidation.source')}</Th>
                <Th num>{t('consolidation.plRate', { cur: g })}</Th>
                <Th>{t('consolidation.source')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.companies.map((c) => (
                <Tr key={c.id}>
                  <Td>{c.name}</Td>
                  <Td>{currencySymbol(c.baseCurrency)}</Td>
                  <Td num>{Number(c.closingRate).toLocaleString('tr-TR', { maximumFractionDigits: 8 })}</Td>
                  <Td className="text-muted">{t(`consolidation.sources.${c.closingSource as 'manual'}`)}</Td>
                  <Td num>{Number(c.plRate).toLocaleString('tr-TR', { maximumFractionDigits: 8 })}</Td>
                  <Td className="text-muted">{t(`consolidation.sources.${c.plSource as 'manual'}`)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Card className="p-5">
        <CardHeader title={t('consolidation.tbTitle')} description={t('consolidation.tbDesc')} />
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('consolidation.code')}</Th>
                <Th>{t('consolidation.accountName')}</Th>
                {data.companies.map((c) => <Th key={c.id} num>{c.name} ({g})</Th>)}
                <Th num>{t('consolidation.elimination')}</Th>
                <Th num>{t('consolidation.consolidated')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Tr key={r.code} data-testid={`tb-${r.code}`}>
                  <Td className="font-mono text-[13px]">{r.code}</Td>
                  <Td>
                    {r.name} {r.unmapped && <Badge tone="warning">{t('consolidation.unmappedBadge')}</Badge>}
                  </Td>
                  {data.companies.map((c) => <Td key={c.id} num className={neg(r.perCompany[c.id] ?? '0')}>{money(r.perCompany[c.id] ?? '0')}</Td>)}
                  <Td num className={neg(r.elimination)}>{isZero(r.elimination) ? '' : money(r.elimination)}</Td>
                  <Td num className={cn('font-medium', neg(r.consolidated))} data-testid={`tb-${r.code}-consolidated`}>{money(r.consolidated)}</Td>
                </Tr>
              ))}
              <Tr data-testid="tb-translation">
                <Td />
                <Td className="text-muted">{t('consolidation.translationDiff')}</Td>
                {data.companies.map((c) => <Td key={c.id} num>{money(data.translationDiff[c.id] ?? '0')}</Td>)}
                <Td num />
                <Td num>{money(data.totals.translationDiff)}</Td>
              </Tr>
            </tbody>
            <tfoot>
              <tr className="bg-surface-2">
                <Td colSpan={2}>{t('consolidation.totalNet')}</Td>
                {data.companies.map((c) => <Td key={c.id} num>{money(String(Number(data.totals.perCompany[c.id] ?? 0) + Number(data.translationDiff[c.id] ?? 0)))}</Td>)}
                <Td num>{money(data.totals.elimination)}</Td>
                <Td num data-testid="tb-total">{money(data.totals.consolidated)}</Td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
        {diffLarge && <p className="mt-2 text-xs text-muted">{t('consolidation.translationNote')}</p>}
      </Card>

      {data.unmapped.length > 0 && (
        <Card className="p-5" data-testid="unmapped">
          <CardHeader title={t('consolidation.unmappedTitle')} description={t('consolidation.unmappedDesc')} />
          <ul className="flex flex-col gap-1 text-sm">
            {data.unmapped.map((r) => (
              <li key={r.code}>
                <span className="font-mono text-[13px]">{r.code}</span> {r.name} — {t('consolidation.presentIn')}: {r.presentIn.map((id) => data.companies.find((c) => c.id === id)?.name).join(', ')} — {moneyIn(r.consolidated, g)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <StatementTable title={t('consolidation.balanceSheet')} lines={data.statements.balanceSheet} data={data} testId="balance-sheet" />
      <StatementTable title={t('consolidation.incomeStatement')} lines={data.statements.incomeStatement} data={data} testId="income-statement" />

      {data.eliminations.length > 0 && (
        <Card className="p-5">
          <CardHeader title={t('consolidation.appliedEliminations')} />
          <ul className="flex flex-col gap-1 text-sm">
            {data.eliminations.map((e) => (
              <li key={e.id}>{e.description} — {formatDateTR(e.periodFrom)} – {formatDateTR(e.periodTo)}</li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-muted">{data.note}</p>
    </div>
  );
}

function UnverifiedNote() {
  const { t } = useTranslation();
  return <div className="rounded-lg border border-border-strong bg-surface-2 p-3 text-sm" role="note">{t('consolidation.unverified')}</div>;
}
