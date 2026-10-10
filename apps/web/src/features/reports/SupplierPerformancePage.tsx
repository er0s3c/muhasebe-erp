import { Link } from 'react-router-dom';
import type { SupplierPerformanceData } from '@erp/shared';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { PeriodFields, periodText, useReportPeriod } from './common';

export function SupplierPerformancePage() {
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const query = useCQuery<SupplierPerformanceData>(
      ['supplier-performance', from, to],
      valid ? `/api/reports/supplier-performance?${new URLSearchParams({ from, to })}` : null,
    ),
    data = query.data;
  const pct = (value: string | null) => (value === null ? '—' : `${money(value)} %`);
  return (
    <div className="min-w-0 print-wide">
      <PageHeader
        title="Tedarikçi teslim, iade ve fiyat performansı"
        description="Kaydedilmiş sipariş, mal kabul ve faturalardan hesaplanan karşılaştırılabilir ölçüler."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link className="link text-sm" to="/reports/insights">
              Rapor panom
            </Link>
            <ExportMenu
              exportKey="supplier-performance"
              params={{ from, to }}
              disabled={!valid || !data?.rows.length}
            />
          </div>
        }
      />
      <PrintHeader subtitle={periodText(from, to)} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </div>
      {!valid ? (
        <Callout tone="warning">Başlangıç ve bitiş tarihini kontrol edin.</Callout>
      ) : query.error ? (
        <Callout tone="danger">{errorMessage(query.error)}</Callout>
      ) : query.isPending || !data ? (
        <PageLoading />
      ) : !data.rows.length ? (
        <Card>
          <EmptyState
            title="Bu dönemde tedarikçi işlemi yok"
            description="Verilmiş sipariş, mal kabul veya alış faturası olduğunda ölçüler görünür. Veri olmadan performans skoru hesaplanmaz."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <Callout title="Ölçülerin dayanağı">
            <p>
              Karşılama, dönemde verilen siparişlerin bitiş tarihine kadar kabul edilen net sipariş
              değeridir. Teslim süresi, dönemdeki her mal kabulün sipariş verilmesinden sonraki gün
              sayısının ortalamasıdır.
            </p>
            <p className="mt-2">
              İade oranı = dönem alış iadesi / dönem net alış. Fiyat sapması, aynı para birimindeki
              siparişe bağlı fatura satırının net tutarı ile sipariş fiyatını karşılaştırır; iskonto
              da farkın içindedir.
            </p>
            <p className="mt-2">
              Taahhüt edilen teslim tarihi kayıtlı olmadığından zamanında teslim oranı ve birleşik
              puan üretilmez. Eksik dayanak “—” olarak gösterilir. Farklı para birimleri ayrı
              satırlardadır.
            </p>
          </Callout>
          <TableWrap>
            <Table>
              <thead>
                <Tr>
                  <Th>Tedarikçi</Th>
                  <Th>Para birimi</Th>
                  <Th num>Sipariş adedi</Th>
                  <Th num>Sipariş net tutarı</Th>
                  <Th num>Kabulün sipariş değeri</Th>
                  <Th num>Karşılama (%)</Th>
                  <Th num>Mal kabul adedi</Th>
                  <Th num>Teslim süresi (gün)</Th>
                  <Th num>Net alış</Th>
                  <Th num>Net iade</Th>
                  <Th num>İade / alış (%)</Th>
                  <Th num>Fiyat örneği (satır)</Th>
                  <Th num>Fiyat sapması (%)</Th>
                </Tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={`${r.partyId}:${r.currency}`}>
                <Td className="min-w-64">
                      <Link className="link" to={`/parties/${r.partyId}`}>
                        {r.name}
                      </Link>
                      <p className="mt-1 font-mono text-xs text-muted">{r.code}</p>
                    </Td>
                    <Td>{r.currency}</Td>
                    <Td num>{r.orderCount}</Td>
                    <Td num>{money(r.orderedAmount)}</Td>
                    <Td num>{money(r.receivedAmount)}</Td>
                    <Td num>{pct(r.fulfilmentPct)}</Td>
                    <Td num>{r.receiptCount}</Td>
                    <Td num>{r.averageLeadDays === null ? '—' : money(r.averageLeadDays)}</Td>
                    <Td num>{money(r.purchaseAmount)}</Td>
                    <Td num>{money(r.returnAmount)}</Td>
                    <Td num>{pct(r.returnPct)}</Td>
                    <Td num>{r.priceComparedLines}</Td>
                    <Td num>{pct(r.priceVariancePct)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <p className="text-xs text-muted">
            {periodText(from, to)} · Saat dilimi: {data.timeZone}. Tutarlar satırın para
            birimindedir, KDV hariçtir; para birimleri arasında toplam alınmaz. İptal edilen sipariş
            ve kabuller hariçtir. Fatura iptalleri ters kaydın tarihinde hesaba girer; önceki dönem
            alışının iadesi bu dönemde oranı %100 üzerine çıkarabilir.
          </p>
        </div>
      )}
    </div>
  );
}
