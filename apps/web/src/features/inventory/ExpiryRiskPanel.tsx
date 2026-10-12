import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { EXPIRY_ADVICE, type ExpiryState } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

interface RiskLot {
  lotId: string;
  code: string;
  status: string;
  itemCode: string;
  itemName: string;
  unit: string;
  warehouseName: string;
  expiryDate: string;
  daysLeft: number;
  quantity: string;
  value: string;
  state: ExpiryState;
}
interface RiskReport {
  today: string;
  lots: RiskLot[];
  truncated: boolean;
  summary: Record<ExpiryState, { count: number; value: string }>;
  lotsWithoutExpiry: number;
}
const STATE: Record<ExpiryState, { label: string; tone: 'danger' | 'warning' | 'info' }> = {
  expired: { label: 'Süresi geçti', tone: 'danger' },
  critical: { label: 'Kritik', tone: 'warning' },
  warning: { label: 'Yaklaşıyor', tone: 'info' },
};

/**
 * Son kullanma ve raf ömrü riski (öneri 47): ufuk içindeki ve süresi geçmiş partiler, kalan miktar ve ortalama maliyetle
 * değeri. Parti yoksa panel görünmez. Otomatik parti seçimi FEFO sırasıyla yapılır; üretim sarfı süresi geçmiş partiyi almaz.
 */
export function ExpiryRiskPanel({ warehouseId }: { warehouseId?: string }) {
  const base = useCompany().baseCurrency;
  const [horizon, setHorizon] = useState('60');
  const [critical, setCritical] = useState('15');
  const h = Math.max(1, Math.min(730, Number(horizon) || 60)),
    k = Math.max(0, Math.min(h, Number(critical) || 0));
  const qs = new URLSearchParams({ horizonDays: String(h), criticalDays: String(k) });
  if (warehouseId) qs.set('warehouseId', warehouseId);
  const q = useCQuery<RiskReport>(
    ['expiry-risk', qs.toString()],
    `/api/inventory/expiry-risk?${qs}`,
    { allowForbidden: true },
  );
  const d = q.data;
  if (!d || (!d.lots.length && !d.lotsWithoutExpiry)) return null;
  return (
    <Card className="mb-5 print:hidden">
      <CardHeader
        title="Son kullanma riski"
        description="Süresi geçmiş ve yaklaşan partiler; değer ortalama maliyetle hesaplanır."
        action={<CalendarClock className="size-5 text-muted" aria-hidden />}
      />
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Ufuk (gün)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={730}
                className="w-28"
                value={horizon}
                onChange={(e) => setHorizon(e.target.value)}
              />
            )}
          </Field>
          <Field label="Kritik (gün)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={365}
                className="w-28"
                value={critical}
                onChange={(e) => setCritical(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2 text-sm">
            {(Object.keys(STATE) as ExpiryState[]).map((s) => (
              <Badge key={s} tone={STATE[s].tone}>
                {STATE[s].label}: {d.summary[s].count} · {money(d.summary[s].value)} {base}
              </Badge>
            ))}
          </div>
        </div>
        {d.lotsWithoutExpiry > 0 && (
          <Callout>
            Raf ömrü tanımlı kartlarda son kullanma tarihi girilmemiş {d.lotsWithoutExpiry} parti
            var; depo ekranından tarih girin.
          </Callout>
        )}
        {d.lots.length > 0 && (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Parti</Th>
                  <Th>Malzeme</Th>
                  <Th>Depo</Th>
                  <Th>Son kullanma</Th>
                  <Th num>Kalan</Th>
                  <Th num>Değer ({base})</Th>
                  <Th>Öneri</Th>
                </tr>
              </thead>
              <tbody>
                {d.lots.map((l) => (
                  <Tr key={l.lotId}>
                    <Td className="font-mono text-xs">
                      {l.code}
                      {l.status === 'quarantine' && (
                        <span className="block text-muted">karantina</span>
                      )}
                    </Td>
                    <Td>
                      {l.itemCode} · {l.itemName}
                    </Td>
                    <Td>{l.warehouseName}</Td>
                    <Td>
                      <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge>
                      <span className="mt-1 block text-xs">
                        {formatDateTR(l.expiryDate)} ·{' '}
                        {l.daysLeft < 0 ? `${-l.daysLeft} gün geçti` : `${l.daysLeft} gün kaldı`}
                      </span>
                    </Td>
                    <Td num>
                      {Number(l.quantity).toLocaleString('tr-TR')} {l.unit}
                    </Td>
                    <Td num>{money(l.value)}</Td>
                    <Td className="text-xs text-muted">{EXPIRY_ADVICE[l.state]}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {d.truncated && <p className="text-xs text-muted">İlk 1000 parti gösteriliyor.</p>}
      </div>
    </Card>
  );
}
