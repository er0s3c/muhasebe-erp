import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

type P = { x: number; y: number };
interface Remnant {
  id: string;
  code: string;
  lotCode: string;
  itemName: string;
  warehouseName: string;
  isRemnant: boolean;
  grade: string;
  tone: string;
  remainingArea: string;
  reservedArea: string;
  freeArea: string;
  outline: P[] | null;
  defects: { code: string; kind: string; points: P[] }[];
}

const path = (pts: P[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x * 100).toFixed(1)} ${(p.y * 100).toFixed(1)}`).join(' ') + ' Z';

/** Parça çizimi ve kusur bölgeleri (normalize 0–1 düzlem). Çizim yoksa kare gösterilir. */
function PieceThumb({ outline, defects }: { outline: P[] | null; defects: Remnant['defects'] }) {
  const shape = outline && outline.length >= 3 ? outline : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  return (
    <svg viewBox="-2 -2 104 104" className="size-20 shrink-0" role="img" aria-label="Parça çizimi">
      <path d={path(shape)} className="fill-surface-2 stroke-border-strong" strokeWidth={1.5} />
      {defects.map((d, i) => (
        <path key={i} d={path(d.points)} className={d.kind === 'hole' ? 'fill-danger/60' : 'fill-warning/50'} />
      ))}
    </svg>
  );
}

/**
 * Kalan deri parçasını görsel bulma (öneri 76): serbest alan kalan alandan, kusur sınıfına göre kullanılamayan alan ve parça
 * rezervasyonları düşülerek hesaplanır; açık kesim planındaki parçalar listelenmez. En küçük uygun parça önce gelir.
 */
export function RemnantSearch() {
  const [minArea, setMinArea] = useState('0.5');
  const [tone, setTone] = useState('');
  const [visibility, setVisibility] = useState<'visible' | 'hidden'>('visible');
  const [remnantsOnly, setRemnantsOnly] = useState(true);
  const qs = new URLSearchParams({ minArea: minArea || '0', visibility, remnantsOnly: String(remnantsOnly), ...(tone.trim() ? { tone: tone.trim() } : {}) });
  const q = useCQuery<{ pieces: Remnant[] }>(['leather', 'remnants', qs.toString()], `/api/leather/materials/remnants?${qs}`);
  return (
    <Card className="mt-5">
      <CardHeader title="Kalan parça arama" description="Kesimden dönen ya da kullanılmayan deri parçalarını çizimleriyle bulun. Kırmızı delik, sarı diğer kusurlardır." />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="En az serbest alan (m²)">{(id) => <Input id={id} inputMode="decimal" className="w-28" value={minArea} onChange={(e) => setMinArea(e.target.value)} />}</Field>
          <Field label="Ton">{(id) => <Input id={id} className="w-32" value={tone} onChange={(e) => setTone(e.target.value)} />}</Field>
          <Field label="Parça konumu">
            {(id) => (
              <Select id={id} value={visibility} onChange={(e) => setVisibility(e.target.value as 'visible' | 'hidden')}>
                <option value="visible">Görünür (kusursuz alan)</option>
                <option value="hidden">Gizli (çizik/ton kabul)</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" className="size-4" checked={remnantsOnly} onChange={(e) => setRemnantsOnly(e.target.checked)} />
            Yalnız kesim kalanları
          </label>
        </div>
        {q.error ? <ErrorCallout error={q.error} /> : null}
        {q.data && q.data.pieces.length === 0 && <p className="text-sm text-muted">Uygun parça yok.</p>}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(q.data?.pieces ?? []).map((p) => (
            <li key={p.id} className="flex gap-3 rounded-md border border-border p-3 text-sm">
              <PieceThumb outline={p.outline} defects={p.defects} />
              <div className="min-w-0">
                <p className="font-medium">
                  {p.code} {p.isRemnant && <Badge tone="neutral">Kalan</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {p.itemName} · {p.lotCode} · {p.warehouseName}
                </p>
                <p className="num">Serbest {p.freeArea} m²</p>
                <p className="text-xs text-muted">
                  Kalan {p.remainingArea} · ayrılmış {p.reservedArea} · {p.grade}
                  {p.tone ? ` · ton ${p.tone}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

interface LeatherCost {
  area: { issued: string; remnantReturned: string; netUsed: string; patternArea: string; yieldPct: string | null; perUnit: string | null };
  value: { leather: string; leatherPerM2: string | null; otherMaterial: string; other: { kind: string; value: string }[]; total: string };
  perUnit: { leather: string | null; otherMaterial: string | null; other: string | null; total: string | null };
}

/** Deri malzemesinden ürün maliyetine görünüm (öneri 15). */
export function LeatherCostCard({ orderId }: { orderId: string }) {
  const can = useCan();
  const base = useCompany().baseCurrency;
  const q = useCQuery<LeatherCost>(['leather', 'leather-cost', orderId], `/api/leather/production/orders/${orderId}/leather-cost`, { enabled: can('manufacturing.costs.read') });
  if (!can('manufacturing.costs.read') || !q.data) return q.error ? <ErrorCallout error={q.error} /> : null;
  const d = q.data;
  const m = (v: string | null) => (v === null ? '—' : moneyIn(v, base));
  return (
    <Card className="mt-5">
      <CardHeader title="Deriden ürün maliyetine" description="Emre verilen deri, dönen kalan parça, kalıp alanına göre verim ve birim mamule düşen maliyet." />
      <dl className="grid gap-3 p-5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted">Net kullanılan deri</dt>
          <dd className="num mt-0.5">
            {d.area.netUsed} m² <span className="text-xs text-muted">(verilen {d.area.issued}, dönen {d.area.remnantReturned})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Kalıp alanı / verim</dt>
          <dd className="num mt-0.5">
            {d.area.patternArea} m² · {d.area.yieldPct === null ? '—' : `%${d.area.yieldPct}`}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Deri değeri</dt>
          <dd className="num mt-0.5">
            {m(d.value.leather)} <span className="text-xs text-muted">({m(d.value.leatherPerM2)}/m²)</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Birim mamul</dt>
          <dd className="num mt-0.5">
            deri {m(d.perUnit.leather)} · diğer malzeme {m(d.perUnit.otherMaterial)} · diğer {m(d.perUnit.other)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

interface Trace {
  lot: { code: string; itemCode: string; itemName: string; quantity: string; remainingQty: string };
  orders: { orderId: string; code: string | null; itemName: string | null; consumedQty: string; outputs: { lotId: string; code: string; quantity: string; shipments: Shipment[] }[] }[];
  directShipments: Shipment[];
  customers: string[];
}
interface Shipment { noteId: string; noteNo: string | null; partyName: string | null; quantity: string }

/** Partiden üretim emirlerine, mamul partilerine ve müşteri sevklerine ileri iz (öneri 79). */
export function LotTraceForward({ lots }: { lots: { id: string; code?: unknown }[] }) {
  const [lotId, setLotId] = useState('');
  const q = useCQuery<Trace>(['wms', 'trace-forward', lotId], lotId ? `/api/manufacturing/lots/${lotId}/trace-forward` : null);
  const ship = (s: Shipment) => `${s.noteNo ?? 'İrsaliye'} · ${s.partyName ?? '—'} · ${s.quantity}`;
  return (
    <Card className="mt-6 p-4">
      <section aria-label="Parti ileri izi" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Parti ileri izi</h3>
        <p className="text-xs text-muted">Aksesuar ya da hammadde partisinin hangi üretim emirlerinde kullanıldığını, oluşan mamul partilerini ve sevk edildiği müşterileri gösterir.</p>
        <Select aria-label="Parti" value={lotId} onChange={(e) => setLotId(e.target.value)}>
          <option value="">Parti seçin</option>
          {lots.map((l) => (
            <option key={l.id} value={l.id}>
              {String(l.code ?? l.id)}
            </option>
          ))}
        </Select>
        {q.error ? <ErrorCallout error={q.error} /> : null}
        {q.data && (
          <div className="space-y-2 text-sm">
            <p>
              {q.data.lot.itemCode} {q.data.lot.itemName} · {q.data.lot.quantity} (kalan {q.data.lot.remainingQty})
            </p>
            {q.data.orders.length === 0 && q.data.directShipments.length === 0 && <p className="text-muted">Henüz kullanım ya da sevk yok.</p>}
            <ul className="space-y-1">
              {q.data.orders.map((o) => (
                <li key={o.orderId}>
                  Emir {o.code ?? '—'} ({o.itemName ?? ''}) · kullanılan {o.consumedQty}
                  <ul className="ml-4 text-xs text-muted">
                    {o.outputs.map((x) => (
                      <li key={x.lotId}>
                        Mamul partisi {x.code} · {x.quantity}
                        {x.shipments.length > 0 && ` → ${x.shipments.map(ship).join('; ')}`}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {q.data.directShipments.map((s) => (
                <li key={s.noteId}>Doğrudan sevk: {ship(s)}</li>
              ))}
            </ul>
            {q.data.customers.length > 0 && <p className="text-xs">Müşteriler: {q.data.customers.join(', ')}</p>}
          </div>
        )}
      </section>
    </Card>
  );
}
