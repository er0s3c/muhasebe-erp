import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { StockAnalyticsData } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Select } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Th, Td, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { qtyText, useUnitLabel } from '../inventory/common';
import { PeriodFields, periodText, useReportPeriod } from './common';

const views = {
  abc: 'ABC sınıflandırması',
  inactive: 'Hareketsiz stok',
  turnover: 'Stok devir hızı',
} as const;
export function StockAnalyticsPage() {
  const { from, to, setFrom, setTo, valid } = useReportPeriod(),
    unitLabel = useUnitLabel();
  const [inactiveDays, setInactiveDays] = useState('90'),
    [view, setView] = useState<keyof typeof views>('abc');
  const query = useCQuery<StockAnalyticsData>(
    ['stock-analytics', from, to, inactiveDays],
    valid
      ? `/api/reports/stock-analytics?${new URLSearchParams({ from, to, inactiveDays })}`
      : null,
  );
  const data = query.data,
    rows = data?.rows.filter((r) => view !== 'inactive' || r.isInactive) ?? [],
    currency = data?.baseCurrency ?? '';
  const pct = (value: string | null) => (value === null ? '—' : `${money(value)} %`);
  return (
    <div className="min-w-0 print-wide">
      <PageHeader
        title="ABC, hareketsiz stok ve devir"
        description="Mevcut stok hareketlerinden ve net satış maliyetinden hesaplanan dönem analizi."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link className="link text-sm" to="/reports/insights">
              Analiz panosu
            </Link>
            <ExportMenu
              exportKey="stock-analytics"
              params={{ from, to, inactiveDays }}
              disabled={!valid || !data?.rows.length}
            />
          </div>
        }
      />
      <PrintHeader
        subtitle={`${periodText(from, to)} · Hareketsizlik eşiği: ${inactiveDays} gün`}
      />
      <div className="mb-5 flex min-w-0 flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <Field label="Hareketsizlik eşiği">
          {(id) => (
            <Select id={id} value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value)}>
              {[30, 60, 90, 180, 365].map((days) => (
                <option key={days} value={days}>
                  {days} gün
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div
        className="mb-5 flex flex-wrap gap-2 print:hidden"
        role="group"
        aria-label="Stok analizi görünümü"
      >
        {Object.entries(views).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={view === key ? 'primary' : 'secondary'}
            aria-pressed={view === key}
            onClick={() => setView(key as keyof typeof views)}
          >
            {label}
          </Button>
        ))}
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
            title="Stok kartı bulunmuyor"
            description="Stok kartları ve hareketleri kaydedildiğinde analiz burada görünür."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Dönem sonu stok değeri">
              {moneyIn(data.totals.closingValue, currency)}
            </Stat>
            <Stat label="Net satış maliyeti">{moneyIn(data.totals.salesCost, currency)}</Stat>
            <Stat label="Hareketsiz stok değeri">
              {moneyIn(data.totals.inactiveValue, currency)}
            </Stat>
            <Stat label={`Dönem devir sayısı · ${data.periodDays} gün`}>
              {data.totals.turnover === null ? '—' : `${money(data.totals.turnover, 4)} kez`}
            </Stat>
          </div>
          <Callout title={views[view]}>
            {view === 'abc'
              ? `ABC, pozitif net satış maliyetini büyükten küçüğe sıralar: ilk %80 A, sonraki %15 B, kalan %5 C. Eşiği aşan ürün başladığı sınıfta kalır. ${data.totals.classifiedCount} / ${data.totals.itemCount} kart sınıflandırıldı. Satış maliyeti sıfır veya negatif olan karta sınıf verilmez.`
              : view === 'inactive'
                ? `Dönem sonunda miktarı pozitif olan ve son miktar hareketi en az ${inactiveDays} gün önce gerçekleşen ürünler. Depolar arası transfer ve yalnız maliyet düzeltmesi süreyi sıfırlamaz.`
                : 'Dönem devir sayısı = net satış maliyeti / ((dönem başı stok değeri + dönem sonu stok değeri) / 2). Yıllıklaştırılmaz. Pozitif maliyet ve ortalama stok bulunmuyorsa veya bakiye negatifse oran hesaplanmaz.'}
          </Callout>
          {view === 'abc' && !data.totals.classifiedCount && (
            <Callout>Bu dönemde pozitif net satış maliyeti yok; ABC sınıfı hesaplanmadı.</Callout>
          )}
          {!rows.length ? (
            <Card>
              <EmptyState title="Bu eşiği aşan hareketsiz stok yok" />
            </Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <Tr>
                    <Th>Kod / ürün</Th>
                    <Th num>Dönem sonu miktarı</Th>
                    {view === 'abc' ? (
                      <>
                        <Th>ABC</Th>
                        <Th num>Net satış maliyeti ({currency})</Th>
                        <Th num>Pay (%)</Th>
                        <Th num>Birikimli (%)</Th>
                      </>
                    ) : view === 'inactive' ? (
                      <>
                        <Th>Son hareket</Th>
                        <Th num>Hareketsiz gün</Th>
                        <Th num>Stok değeri ({currency})</Th>
                      </>
                    ) : (
                      <>
                        <Th num>Dönem başı ({currency})</Th>
                        <Th num>Dönem sonu ({currency})</Th>
                        <Th num>Ortalama stok ({currency})</Th>
                        <Th num>Net satış maliyeti ({currency})</Th>
                        <Th num>Devir (kez)</Th>
                        <Th num>Stokta kalma (gün)</Th>
                      </>
                    )}
                  </Tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.itemId}>
                  <Td className="min-w-48">
                        <Link className="link" to={`/inventory/items/${r.itemId}`}>
                          {r.name}
                        </Link>
                        <p className="mt-1 font-mono text-xs text-muted">{r.code}</p>
                      </Td>
                      <Td num>
                        {qtyText(r.closingQty)} {unitLabel(r.unit)}
                      </Td>
                      {view === 'abc' ? (
                        <>
                          <Td>
                            {r.abcClass ? (
                              <Badge tone={r.abcClass === 'A' ? 'brand' : 'neutral'}>
                                {r.abcClass}
                              </Badge>
                            ) : (
                              '—'
                            )}
                          </Td>
                          <Td num>{money(r.salesCost)}</Td>
                          <Td num>{pct(r.costSharePct)}</Td>
                          <Td num>{pct(r.cumulativePct)}</Td>
                        </>
                      ) : view === 'inactive' ? (
                        <>
                          <Td>{formatDateTR(r.lastMovementDate)}</Td>
                          <Td num>{r.daysInactive ?? '—'}</Td>
                          <Td num>{money(r.closingValue)}</Td>
                        </>
                      ) : (
                        <>
                          <Td num>{money(r.openingValue)}</Td>
                          <Td num>{money(r.closingValue)}</Td>
                          <Td num>{money(r.averageValue)}</Td>
                          <Td num>{money(r.salesCost)}</Td>
                          <Td num>{r.turnover === null ? '—' : money(r.turnover, 4)}</Td>
                          <Td num>{r.holdingDays === null ? '—' : money(r.holdingDays)}</Td>
                        </>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <p className="text-xs text-muted">
            {periodText(from, to)} · Tutarlar {currency} defter para biriminde, miktarlar kartın
            birimindedir. Satış iadeleri ve iptaller kendi işlem tarihinde net maliyeti azaltır. Bu
            rapor hesaplanan değerleri gösterir; gelecek talep tahmini yapmaz.
          </p>
        </div>
      )}
    </div>
  );
}
