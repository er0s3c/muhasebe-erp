import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { PageLoading } from '../../components/ui/Feedback';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { ProjectDetail, SalesSummary } from '../../lib/types';
import { UNIT_STATUSES } from '../realestate/common';

/** Kendi projesinde satış özeti: birim durumları, para birimi bazında sözleşme, tahsil edilen, kalan ve geciken tutar. */
export function SalesTab({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const { data, isPending } = useCQuery<SalesSummary>(['sales-summary', project.id], `/api/projects/${project.id}/sales-summary`);
  if (isPending || !data) return <PageLoading />;
  const total = UNIT_STATUSES.reduce((s, k) => s + data.units[k].count, 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {UNIT_STATUSES.map((s) => (
          <Stat key={s} label={t(`realEstate.unitStatus.${s}`)} sub={`${Number(data.units[s].grossM2).toLocaleString('tr-TR')} m²`}>
            {data.units[s].count}
          </Stat>
        ))}
      </div>
      {total === 0 ? (
        <p className="text-sm text-muted">{t('realEstate.summary.empty')}</p>
      ) : (
        <Card>
          <CardHeader title={t('realEstate.summary.title')} action={<Link className="text-sm underline" to="/real-estate/contracts">{t('realEstate.contracts.title')}</Link>} />
          {data.byCurrency.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t('realEstate.contracts.empty')}</p>
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th>{t('realEstate.units.currency')}</Th>
                    <Th num>{t('realEstate.summary.contracts')}</Th>
                    <Th num>{t('realEstate.summary.price')}</Th>
                    <Th num>{t('realEstate.summary.collected')}</Th>
                    <Th num>{t('realEstate.summary.remaining')}</Th>
                    <Th num>{t('realEstate.summary.overdue')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCurrency.map((r) => (
                    <Tr key={r.currencyCode}>
                      <Td>{r.currencyCode}</Td>
                      <Td num>{r.contracts}</Td>
                      <Td num>{moneyIn(r.price, r.currencyCode)}</Td>
                      <Td num>{moneyIn(r.collected, r.currencyCode)}</Td>
                      <Td num>{moneyIn(r.remaining, r.currencyCode)}</Td>
                      <Td num className={Number(r.overdue) > 0 ? 'text-danger' : ''}>{moneyIn(r.overdue, r.currencyCode)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      )}
    </div>
  );
}
