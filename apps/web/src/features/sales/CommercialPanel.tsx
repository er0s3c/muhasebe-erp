import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { fmtDateTime } from '../../lib/license';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { qtyText } from '../inventory/common';

interface SnapLine {
  lineNo: number;
  itemId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  net: string;
  netBase: string;
  unitCostBase: string | null;
  costBase: string;
  costKnown: boolean;
}
interface Snapshot {
  id: string;
  event: 'sent' | 'confirmed';
  revisionNo: number;
  currencyCode: string;
  fxRate: string | null;
  netBase: string;
  costBase: string;
  marginPct: string | null;
  minMarginPct: string | null;
  creditLimit: string | null;
  exposure: string | null;
  warnings: string[];
  overrideReason: string | null;
  lines: SnapLine[];
  createdAt: string;
}
interface CommercialView {
  validity: { validUntil: string | null; daysLeft: number | null; expired: boolean };
  snapshot: Snapshot | null;
  current: { fxRate: string | null; netBase: string; costBase: string; marginPct: string | null; lines: (SnapLine & { snapshotUnitCostBase: string | null; costDiffBase: string | null })[] };
  changes: { fxRate: { then: string | null; now: string | null } | null; costBase: string; marginPts: string | null } | null;
}
type Span = { from: string; to: string };
interface Revision extends Snapshot {
  userName: string | null;
  docNet: string;
  concession: string | null;
  marginPts: string | null;
  lineChanges: ({ lineNo: number; description: string; change: 'added' | 'removed' } | { lineNo: number; description: string; change: 'changed'; unitPrice: Span; discountPct: Span; quantity: Span; net: Span })[];
}

const WARNING_LABEL: Record<string, string> = {
  MARGIN_BELOW_MIN: 'Katkı asgarinin altında',
  CREDIT_LIMIT_EXCEEDED: 'Kredi limiti aşıldı',
  COST_UNKNOWN: 'Bazı satırların maliyeti bilinmiyor',
  FX_RATE_MISSING: 'Kur bulunamadı',
};
const pct = (v: string | null) => (v === null ? '—' : `%${v}`);

/**
 * Teklif/sipariş ticari görünümü (F6: 33, 34, 35, 38): gönderim/onay anındaki maliyet ve katkı, bugünkü maliyetle fark,
 * teklif geçerliliği ve teklif revizyonları arasındaki taviz. Tutarlar defter para birimindedir.
 */
export function CommercialPanel({ docId, kind }: { docId: string; kind: 'quote' | 'order' }) {
  const base = useCompany().baseCurrency;
  const view = useCQuery<CommercialView>(['sales-doc', docId, 'commercial'], `/api/sales-docs/${docId}/commercial`);
  const neg = useCQuery<{ revisions: Revision[]; reopens: { reason: string | null; at: string; userName: string | null }[]; totalConcession: string }>(
    ['sales-doc', docId, 'negotiation'],
    kind === 'quote' ? `/api/sales-docs/${docId}/negotiation` : null,
  );
  const v = view.data;
  if (!v) return null;
  const s = v.snapshot;
  const sent = (neg.data?.revisions ?? []).filter((r) => r.event === 'sent');

  return (
    <Card className="p-5 print:hidden">
      <section aria-label="Ticari görünüm" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Ticari görünüm</h2>
          {kind === 'quote' && v.validity.validUntil && (
            <Badge tone={v.validity.expired ? 'danger' : (v.validity.daysLeft ?? 99) <= 3 ? 'warning' : 'neutral'} dot>
              {v.validity.expired ? `Geçerlilik doldu (${formatDateTR(v.validity.validUntil)})` : `Geçerlilik: ${v.validity.daysLeft} gün`}
            </Badge>
          )}
          <span className="text-xs text-muted">Tutarlar {base}; maliyet stok defteri ortalaması (yoksa son alış).</span>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted">{s ? (s.event === 'sent' ? `Gönderimde katkı (rev. ${s.revisionNo})` : 'Onayda katkı') : 'Katkı (taslak)'}</dt>
            <dd className="num mt-0.5 font-medium">{pct(s ? s.marginPct : v.current.marginPct)}</dd>
          </div>
          <div>
            <dt className="text-muted">Bugünkü katkı</dt>
            <dd className="num mt-0.5">
              {pct(v.current.marginPct)}
              {v.changes?.marginPts && dec(v.changes.marginPts).lt(0) && <span className="ml-2 text-danger">{v.changes.marginPts} puan</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Net satış / maliyet</dt>
            <dd className="num mt-0.5">
              {money(v.current.netBase)} / {money(v.current.costBase)}
            </dd>
          </div>
          {v.changes && (
            <div>
              <dt className="text-muted">Maliyet farkı (görüntüden bu yana)</dt>
              <dd className={`num mt-0.5 ${dec(v.changes.costBase).gt(0) ? 'text-danger' : ''}`}>{money(v.changes.costBase)}</dd>
            </div>
          )}
        </dl>

        {s && (s.warnings.length > 0 || s.overrideReason) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {s.warnings.map((w) => (
              <Badge key={w} tone={w === 'COST_UNKNOWN' || w === 'FX_RATE_MISSING' ? 'neutral' : 'warning'}>
                {WARNING_LABEL[w] ?? w}
              </Badge>
            ))}
            {s.creditLimit && s.exposure && <span className="text-muted">Risk {money(s.exposure)} / limit {money(s.creditLimit)}</span>}
            {s.overrideReason && <span>Gerekçe: {s.overrideReason}</span>}
          </div>
        )}

        {v.changes && v.current.lines.some((l) => l.costDiffBase && !dec(l.costDiffBase).isZero()) && (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Satır</Th>
                  <Th num>Miktar</Th>
                  <Th num>Birim maliyet (görüntü)</Th>
                  <Th num>Birim maliyet (bugün)</Th>
                  <Th num>Fark</Th>
                </tr>
              </thead>
              <tbody>
                {v.current.lines
                  .filter((l) => l.costDiffBase && !dec(l.costDiffBase).isZero())
                  .map((l) => (
                    <Tr key={l.lineNo}>
                      <Td>{l.description}</Td>
                      <Td num>{qtyText(l.quantity)}</Td>
                      <Td num>{l.snapshotUnitCostBase ? money(l.snapshotUnitCostBase, 4) : '—'}</Td>
                      <Td num>{l.unitCostBase ? money(l.unitCostBase, 4) : '—'}</Td>
                      <Td num className={dec(l.costDiffBase!).gt(0) ? 'text-danger' : ''}>{money(l.costDiffBase!)}</Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
          </TableWrap>
        )}

        {kind === 'quote' && sent.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium">
              Müzakere geçmişi
              {neg.data && sent.length > 1 && <span className="ml-2 font-normal text-muted">Toplam taviz: {money(neg.data.totalConcession)} {sent[0]!.currencyCode}</span>}
            </h3>
            <ol className="flex flex-col gap-2 text-sm">
              {sent.map((r) => (
                <li key={r.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap gap-x-3 text-muted">
                    <span className="font-medium text-text">Revizyon {r.revisionNo}</span>
                    <span className="num">{fmtDateTime(r.createdAt)}</span>
                    {r.userName && <span>{r.userName}</span>}
                    <span className="num">Net {money(r.docNet)} {r.currencyCode}</span>
                    <span className="num">Katkı {pct(r.marginPct)}</span>
                    {r.concession !== null && <span className={`num ${dec(r.concession).gt(0) ? 'text-danger' : ''}`}>Taviz {money(r.concession)}</span>}
                  </div>
                  {r.lineChanges.length > 0 && (
                    <ul className="mt-1 text-xs">
                      {r.lineChanges.map((c, i) => (
                        <li key={i}>
                          {c.lineNo}. {c.description}:{' '}
                          {c.change === 'changed'
                            ? `fiyat ${money(c.unitPrice.from, 2)} → ${money(c.unitPrice.to, 2)}, iskonto %${dec(c.discountPct.from).toString()} → %${dec(c.discountPct.to).toString()}, miktar ${qtyText(c.quantity.from)} → ${qtyText(c.quantity.to)}`
                            : c.change === 'added'
                              ? 'eklendi'
                              : 'çıkarıldı'}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            {neg.data && neg.data.reopens.length > 0 && (
              <p className="mt-2 text-xs text-muted">Geri alma gerekçeleri: {neg.data.reopens.map((r) => r.reason ?? '—').join(' · ')}</p>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
