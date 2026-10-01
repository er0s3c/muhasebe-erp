import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { MatchRow } from '../../lib/types';
import { qtyText } from '../inventory/common';

/** Alış faturasının sipariş bağlı satırları için sipariş – mal kabul – fatura karşılaştırması. */
export function MatchCard({ invoiceId, currency, overrideReason }: { invoiceId: string; currency: string; overrideReason: string | null }) {
  const { t } = useTranslation();
  const { data } = useCQuery<{ rows: MatchRow[] }>(['invoice', invoiceId, 'match'], `/api/invoices/${invoiceId}/match`);
  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader title={t('procurement.match.detailTitle')} description={overrideReason ? `${t('procurement.match.override')}: ${overrideReason}` : undefined} />
      <TableWrap className="rounded-none border-0">
        <Table>
          <thead>
            <tr>
              <Th>{t('procurement.match.cols.order')}</Th>
              <Th num>{t('procurement.match.cols.ordered')}</Th>
              <Th num>{t('procurement.match.cols.received')}</Th>
              <Th num>{t('procurement.match.cols.invoiceQty')}</Th>
              <Th num>{t('procurement.match.cols.orderPrice')}</Th>
              <Th num>{t('procurement.match.cols.invoicePrice')}</Th>
              <Th>{t('procurement.match.cols.status')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={`${r.lineNo}-${r.poLineId}`}>
                <Td>
                  <span className="font-mono text-[13px]">{r.orderCode}</span>
                  <span className="block text-xs text-muted">{r.description}</span>
                </Td>
                <Td num>{qtyText(r.orderedQty)}</Td>
                <Td num>{qtyText(r.receivedQty)}</Td>
                <Td num>{qtyText(r.invoiceQty)}</Td>
                <Td num>{moneyIn(r.orderPrice, currency, 4)}</Td>
                <Td num>
                  {moneyIn(r.invoicePrice, currency, 4)}
                  {r.priceDiffPct && r.priceDiffPct !== '0.00' && <span className="block text-xs text-muted">%{r.priceDiffPct}</span>}
                </Td>
                <Td>
                  {r.flags.length === 0 ? (
                    <Badge tone="success">{t('procurement.match.state.ok')}</Badge>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {r.flags.map((f) => (
                        <Badge key={f} tone="warning">
                          {t(`procurement.match.flags.${f}`)}
                        </Badge>
                      ))}
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </Card>
  );
}
