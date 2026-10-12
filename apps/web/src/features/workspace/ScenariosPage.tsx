import { Printer, TrendingDown } from 'lucide-react';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Th, Td, Tr } from '../../components/ui/Table';
import { useState } from 'react';
import { type CashScenarioInput } from '@erp/shared';
import { useCMutation, useCQuery, useCan } from '../../lib/queries';
import { PageHeader, Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { moneyIn } from '../../lib/format';
import { useCompany } from '../../lib/session';
import { dec } from '@erp/shared';
type Row = { week: number; closing: string; inflow: string; outflow: string };
type Result = {
  assumptions: CashScenarioInput;
  baseline: { opening: string; missingRate: number; baseCurrency: string; buckets: Row[] };
  scenario: {
    buckets: Row[];
    closing: string;
    lowest: string;
    movedBeyondHorizon: { inflow: string; outflow: string };
  };
};
export function ScenariosPage() {
  const company = useCompany();
  return <ScenariosContent key={company.id} />;
}
function ScenariosContent() {
  const [input, setInput] = useState<CashScenarioInput>({
    name: 'Tahsilat gecikmesi',
    delayDays: 30,
    outflowIncreasePct: 15,
    weeks: 13,
  });
  const preview = useCMutation((v: CashScenarioInput, call) =>
    call<Result>('/api/workspace/cash-scenarios/preview', { method: 'POST', body: v }),
  );
  const save = useCMutation(
    (v: CashScenarioInput, call) =>
      call('/api/workspace/cash-scenarios', { method: 'POST', body: v }),
    [['cash-scenarios']],
  );
  const saved = useCQuery<{
    items: { id: string; name: string; assumptions: CashScenarioInput }[];
  }>(['cash-scenarios'], '/api/workspace/cash-scenarios');
  const canSave = useCan()('treasury.manage');
  const result = preview.data;
  return (
    <>
      <PageHeader
        title="Nakit senaryoları"
        description="Tahsilat gecikmesi ve maliyet artışının nakit planına etkisini karşılaştırın."
        actions={
          <Button onClick={() => window.print()}>
            <Printer className="size-4" />
            Yazdır / PDF
          </Button>
        }
      />
      {(preview.error || save.error || saved.error) && (
        <Callout tone="danger">{(preview.error ?? save.error ?? saved.error)?.message}</Callout>
      )}
      <Card className="mb-5 p-5">
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            preview.mutate(input);
          }}
        >
          <label className="text-sm">
            Senaryo adı
            <Input
              required
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
            />
          </label>
          <label className="text-sm">
            Giriş gecikmesi (gün)
            <Input
              type="number"
              min={0}
              max={365}
              value={input.delayDays}
              onChange={(e) => setInput({ ...input, delayDays: Number(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            Nakit çıkışı artışı (%)
            <Input
              type="number"
              min={0}
              max={500}
              step="any"
              value={input.outflowIncreasePct}
              onChange={(e) => setInput({ ...input, outflowIncreasePct: Number(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            Hafta
            <Input
              type="number"
              min={1}
              max={26}
              value={input.weeks}
              onChange={(e) => setInput({ ...input, weeks: Number(e.target.value) })}
            />
          </label>
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={preview.isPending}>
              Karşılaştır
            </Button>
            {canSave && (
              <Button disabled={save.isPending} onClick={() => save.mutate(input)}>
                Varsayımları sakla
              </Button>
            )}
          </div>
        </form>
        {save.isSuccess && (
          <p role="status" className="mt-3 text-sm">
            Senaryo varsayımları saklandı.
          </p>
        )}
      </Card>
      <div className="mb-4 flex flex-wrap gap-2">
        {saved.data?.items.map((s) => (
          <Button
            key={s.id}
            onClick={() => {
              setInput(s.assumptions);
              preview.mutate(s.assumptions);
            }}
          >
            {s.name}
          </Button>
        ))}
      </div>
      {result && (
        <>
          <h2 className="mb-3 font-semibold">
            {result.assumptions.name}: {result.assumptions.delayDays} gün gecikme, %
            {result.assumptions.outflowIncreasePct} çıkış artışı
          </h2>
          {result.baseline.missingRate > 0 && (
            <Callout tone="warning">
              {result.baseline.missingRate} kalemde güncel kur eksik; karşılaştırma yaklaşık değer
              içerir.
            </Callout>
          )}
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Stat label="Senaryo sonu" sub="Dönem kapanış bakiyesi">
              {moneyIn(result.scenario.closing, result.baseline.baseCurrency)}
            </Stat>
            <Stat label="En düşük bakiye" sub="Dönem içindeki nakit ihtiyacı">
              <span className={dec(result.scenario.lowest).lt(0) ? 'text-danger' : ''}>
                {moneyIn(result.scenario.lowest, result.baseline.baseCurrency)}
              </span>
            </Stat>
            <Stat label="Dönem dışına kayan giriş" sub="Seçilen döneme yetişmeyen tahsilat">
              {moneyIn(result.scenario.movedBeyondHorizon.inflow, result.baseline.baseCurrency)}
            </Stat>
          </div>
          <CashChart result={result} />
          <TableWrap>
            <Table>
              <thead>
                <Tr>
                  <Th>Hafta</Th>
                  <Th num>Mevcut kapanış</Th>
                  <Th num>Senaryo kapanış</Th>
                  <Th num>Fark</Th>
                </Tr>
              </thead>
              <tbody>
                {result.scenario.buckets.map((b, i) => (
                  <Tr key={b.week}>
                    <Td>{b.week}</Td>
                    <Td num>
                      {moneyIn(result.baseline.buckets[i]!.closing, result.baseline.baseCurrency)}
                    </Td>
                    <Td num>{moneyIn(b.closing, result.baseline.baseCurrency)}</Td>
                    <Td num>
                      {moneyIn(
                        dec(b.closing).minus(result.baseline.buckets[i]!.closing).toFixed(2),
                        result.baseline.baseCurrency,
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <p className="mt-3 text-sm text-muted">
            Karşılaştırma seçilen dönemdeki kaynak kalemleri kullanır. Zaten dönem dışında olan
            kalemler bu tablonun dışında kalır.
          </p>
        </>
      )}
    </>
  );
}

function CashChart({ result }: { result: Result }) {
  const series = [result.baseline.buckets, result.scenario.buckets];
  const values = series.flatMap((s) => s.map((r) => Number(r.closing)));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = Math.max(1, max - min);
  const x = (i: number) => 60 + (i * 620) / Math.max(1, result.scenario.buckets.length - 1);
  const y = (v: number) => 190 - ((v - min) * 150) / range;
  const path = (rows: Row[]) =>
    rows.map((r, i) => (i ? 'L' : 'M') + x(i) + ',' + y(Number(r.closing))).join(' ');
  return (
    <Card className="mb-5 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-base">
          <TrendingDown className="size-4 text-muted" />
          Haftalık nakit seyri
        </h3>
        <div className="flex gap-4 text-xs text-muted">
          <span>Kesikli: mevcut plan</span>
          <span>Düz: senaryo</span>
        </div>
      </div>
      <svg
        viewBox="0 0 720 230"
        className="max-h-64 w-full"
        role="img"
        aria-label="Haftalık mevcut ve senaryo kapanış bakiyeleri; ayrıntılı değerler aşağıdaki tabloda"
      >
        <line x1="60" x2="680" y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" />
        <path
          d={path(series[0]!)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="5 5"
          className="text-muted"
        />
        <path
          d={path(series[1]!)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-text"
        />
        {result.scenario.buckets.map((r, i) => (
          <g key={r.week}>
            <circle cx={x(i)} cy={y(Number(r.closing))} r="3" fill="currentColor">
              <title>
                {r.week}. hafta: {moneyIn(r.closing, result.baseline.baseCurrency)}
              </title>
            </circle>
            {(i === 0 || i === result.scenario.buckets.length - 1) && (
              <text
                x={x(i)}
                y="215"
                textAnchor="middle"
                fill="currentColor"
                className="text-[12px]"
              >
                {r.week}. hafta
              </text>
            )}
          </g>
        ))}
      </svg>
    </Card>
  );
}
