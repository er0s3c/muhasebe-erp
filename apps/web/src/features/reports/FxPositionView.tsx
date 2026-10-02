import { useTranslation } from 'react-i18next';
import { Callout, EmptyState } from '../../components/ui/Feedback';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { currencySymbol, formatDateTR, isZero, money, moneyIn } from '../../lib/format';
import type { CompanyFxPositionData, ExcludedMember, GroupFxPositionData } from '../../lib/types';
import { cn } from '../../lib/cn';

const signed = (v: string | null, cur: string) => (v === null ? <span className="text-muted">—</span> : <span className={cn(Number(v) > 0 && 'text-success', Number(v) < 0 && 'text-danger')}>{moneyIn(v, cur)}</span>);

export function ExcludedNotice({ excluded }: { excluded: ExcludedMember[] }) {
  const { t } = useTranslation();
  if (excluded.length === 0) return null;
  return (
    <Callout tone="warning" title={t('consolidation.incompleteTitle')}>
      {t('consolidation.incompleteBody', { n: excluded.length })}
      <ul className="mt-1 list-disc pl-5">
        {excluded.map((e) => (
          <li key={e.companyId} data-testid="excluded-member">
            <span className="font-mono text-xs">{e.companyId.slice(0, 8)}</span> — {t(`consolidation.deny.${e.reason}`)}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Şirket döviz pozisyonu: para birimi başına kasa/banka + alacak − borç, kur, karşılık ve gerçekleşmemiş kur farkı TAHMİNİ. */
export function CompanyFxPositionView({ data }: { data: CompanyFxPositionData }) {
  const { t } = useTranslation();
  const base = data.company.baseCurrency;
  if (data.rows.length === 0) return <EmptyState title={t('fxPosition.empty')} description={t('fxPosition.emptyDesc', { cur: base })} />;
  return (
    <div className="flex flex-col gap-5" data-testid="fx-position">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label={t('fxPosition.equivalent', { cur: base })}>{data.totals ? moneyIn(data.totals.equivalent, base) : '—'}</Stat>
        <Stat label={t('fxPosition.unrealized')} sub={t('fxPosition.unrealizedNote')}>{data.totals ? signed(data.totals.unrealized, base) : '—'}</Stat>
        <Stat label={t('fxPosition.realized', { year: data.realized.to.slice(0, 4) })} sub={t('fxPosition.realizedNote', { gain: money(data.realized.gain), loss: money(data.realized.loss) })}>{signed(data.realized.net, base)}</Stat>
      </div>
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('fxPosition.currency')}</Th>
              <Th num>{t('fxPosition.cash')}</Th>
              <Th num>{t('fxPosition.receivables')}</Th>
              <Th num>{t('fxPosition.payables')}</Th>
              <Th num>{t('fxPosition.net')}</Th>
              <Th num>{t('fxPosition.rate')}</Th>
              <Th num>{t('fxPosition.equivalent', { cur: currencySymbol(base) })}</Th>
              <Th num>{t('fxPosition.book', { cur: currencySymbol(base) })}</Th>
              <Th num>{t('fxPosition.unrealized')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <Tr key={r.currency} data-testid={`fx-row-${r.currency}`}>
                <Td>{r.currency}</Td>
                <Td num>{isZero(r.cash) ? '' : moneyIn(r.cash, r.currency)}</Td>
                <Td num>{isZero(r.receivables) ? '' : moneyIn(r.receivables, r.currency)}</Td>
                <Td num>{isZero(r.payables) ? '' : moneyIn(r.payables, r.currency)}</Td>
                <Td num>{moneyIn(r.net, r.currency)}</Td>
                <Td num>{r.rate ? Number(r.rate).toLocaleString('tr-TR', { maximumFractionDigits: 6 }) : <span className="text-danger">{t('fxPosition.noRate')}</span>}</Td>
                <Td num>{r.equivalent === null ? '—' : moneyIn(r.equivalent, base)}</Td>
                <Td num>{moneyIn(r.bookNet, base)}</Td>
                <Td num>{signed(r.unrealized, base)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <p className="text-xs text-muted">{data.note}</p>
      <p className="text-xs text-muted">{t('fxPosition.asOfNote', { asOf: formatDateTR(data.asOf), rateDate: formatDateTR(data.rateDate) })}</p>
    </div>
  );
}

export function GroupFxPositionView({ data }: { data: GroupFxPositionData }) {
  const { t } = useTranslation();
  const g = data.group.reportingCurrency;
  return (
    <div className="flex flex-col gap-5" data-testid="group-fx-position">
      <ExcludedNotice excluded={data.excluded} />
      {data.rows.length === 0 ? (
        <EmptyState title={t('fxPosition.empty')} description={t('fxPosition.emptyDescGroup')} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Stat label={t('fxPosition.equivalent', { cur: g })}>{data.totals ? moneyIn(data.totals.equivalent, g) : '—'}</Stat>
            <Stat label={t('fxPosition.unrealized')} sub={t('fxPosition.unrealizedNote')}>{data.totals ? signed(data.totals.unrealized, g) : '—'}</Stat>
          </div>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('fxPosition.currency')}</Th>
                  <Th num>{t('fxPosition.cash')}</Th>
                  <Th num>{t('fxPosition.receivables')}</Th>
                  <Th num>{t('fxPosition.payables')}</Th>
                  <Th num>{t('fxPosition.net')}</Th>
                  <Th num>{t('fxPosition.equivalent', { cur: currencySymbol(g) })}</Th>
                  <Th num>{t('fxPosition.unrealized')}</Th>
                  <Th num>{t('fxPosition.companies')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={r.currency} data-testid={`group-fx-row-${r.currency}`}>
                    <Td>{r.currency}</Td>
                    <Td num>{isZero(r.cash) ? '' : moneyIn(r.cash, r.currency)}</Td>
                    <Td num>{isZero(r.receivables) ? '' : moneyIn(r.receivables, r.currency)}</Td>
                    <Td num>{isZero(r.payables) ? '' : moneyIn(r.payables, r.currency)}</Td>
                    <Td num>{moneyIn(r.net, r.currency)}</Td>
                    <Td num>{r.equivalent === null ? '—' : moneyIn(r.equivalent, g)}</Td>
                    <Td num>{signed(r.unrealized, g)}</Td>
                    <Td num>{r.companies}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <h3 className="text-sm text-muted">{t('fxPosition.perCompany')}</h3>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('consolidation.company')}</Th>
                  <Th>{t('fxPosition.currency')}</Th>
                  <Th num>{t('fxPosition.net')}</Th>
                  <Th num>{t('fxPosition.unrealizedCompany')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.perCompany.flatMap((c) =>
                  c.rows.map((r) => (
                    <Tr key={`${c.company.id}-${r.currency}`}>
                      <Td>{c.company.name}</Td>
                      <Td>{r.currency}</Td>
                      <Td num>{moneyIn(r.net, r.currency)}</Td>
                      <Td num>{signed(r.unrealized, c.company.baseCurrency)}</Td>
                    </Tr>
                  )),
                )}
              </tbody>
            </Table>
          </TableWrap>
        </>
      )}
      <p className="text-xs text-muted">{data.note}</p>
    </div>
  );
}
