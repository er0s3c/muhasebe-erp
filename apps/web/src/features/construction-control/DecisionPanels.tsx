import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';

const MISSING: Record<string, string> = { drawing: 'çizim', material: 'malzeme', crew: 'ekip', approval: 'onay' };
const STATUS = { ready: { label: 'Hazır', tone: 'success' }, blocked: { label: 'Engelli', tone: 'warning' }, unknown: { label: 'Kayıt yok', tone: 'neutral' } } as const;

interface Lookahead {
  until: string;
  activities: { activityId: string; title: string; start: string; end: string; critical: boolean; crew: string | null; startsInDays: number; status: keyof typeof STATUS; missing: string[]; blocker: string; owner: string | null; atRisk: boolean }[];
  summary: { total: number; ready: number; blocked: number; unknown: number; criticalAtRisk: number };
}
interface Leveling {
  crews: { name: string; size: number }[];
  before: { crew: string; capacity: number; overloadDays: { day: string; demand: number }[] }[];
  after: { crew: string; capacity: number; overloadDays: { day: string; demand: number }[] }[];
  shifts: { id: string; title: string; crew: string; shiftDays: number; from: string; to: string; slack: number }[];
}

/** İş cephesi hazırlığı (84) ve ekip dengeleme önerisi (87). */
export function ReadinessAndLeveling({ projectId }: { projectId: string }) {
  const la = useCQuery<Lookahead>(['construction', 'lookahead', projectId], `/api/construction/lookahead?projectId=${projectId}`);
  const lv = useCQuery<Leveling>(['construction', 'leveling', projectId], `/api/construction/program/leveling?projectId=${projectId}`);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="İş cephesi hazırlığı"
          description="Önümüzdeki üç haftada başlayacak işlerin çizim, malzeme, ekip ve onay hazırlığı. Yedi gün içinde başlayıp hazır olmayan iş risklidir."
        />
        <div className="p-5">
          {la.error ? <ErrorCallout error={la.error} /> : null}
          {la.data && (
            <>
              <p className="mb-3 text-sm text-muted">
                {la.data.summary.total} iş · {la.data.summary.ready} hazır · {la.data.summary.blocked} engelli · {la.data.summary.unknown} kayıtsız · kritik ve riskli {la.data.summary.criticalAtRisk}
              </p>
              {la.data.activities.length === 0 ? (
                <p className="text-sm text-muted">Bu dönemde başlayacak iş yok.</p>
              ) : (
                <TableWrap>
                  <Table>
                    <thead>
                      <tr>
                        <Th>İş</Th>
                        <Th>Başlangıç</Th>
                        <Th>Hazırlık</Th>
                        <Th>Engel</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {la.data.activities.map((a) => (
                        <Tr key={a.activityId}>
                          <Td>
                            {a.title} {a.critical && <Badge tone="danger">Kritik</Badge>}
                            {a.crew && <span className="ml-1 text-xs text-muted">{a.crew}</span>}
                          </Td>
                          <Td>
                            {formatDateTR(a.start)} <span className="text-xs text-muted">({a.startsInDays <= 0 ? 'başladı' : `${a.startsInDays} gün`})</span>
                          </Td>
                          <Td>
                            <Badge tone={a.atRisk ? 'danger' : STATUS[a.status].tone} dot>
                              {STATUS[a.status].label}
                              {a.missing.length ? `: ${a.missing.map((m) => MISSING[m] ?? m).join(', ')}` : ''}
                            </Badge>
                          </Td>
                          <Td className="text-xs">
                            {a.blocker}
                            {a.owner && <span className="text-muted"> · {a.owner}</span>}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Ekip dengeleme önerisi" description="Ekip kapasitesi takvim kaydında, iş başına ekip ve kişi sayısı program işinde tanımlanır. Öneri bollukla sınırlıdır; programı değiştirmez." />
        <div className="space-y-3 p-5 text-sm">
          {lv.error ? <ErrorCallout error={lv.error} /> : null}
          {lv.data && lv.data.crews.length === 0 && <p className="text-muted">Onaylı takvimde ekip kapasitesi tanımlı değil.</p>}
          {lv.data?.before.map((b) => {
            const a = lv.data!.after.find((x) => x.crew === b.crew);
            return (
              <p key={b.crew}>
                <span className="font-medium">{b.crew}</span> (kapasite {b.capacity}): önce {b.overloadDays.length} aşım günü, öneriyle {a?.overloadDays.length ?? 0}
                {a && a.overloadDays.length > 0 && <span className="text-danger"> — bollukla çözülemeyen: {a.overloadDays.map((d) => `${formatDateTR(d.day)} (${d.demand})`).join(', ')}</span>}
              </p>
            );
          })}
          {lv.data && lv.data.shifts.length > 0 && (
            <ul className="list-disc pl-5">
              {lv.data.shifts.map((s) => (
                <li key={s.id}>
                  {s.title}: {formatDateTR(s.from)} → {formatDateTR(s.to)} ({s.shiftDays} iş günü, bolluk {s.slack})
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

interface Impact {
  items: { id: string; title: string; status: string; firm: boolean; currency: string; cost: string; revenue: string; margin: string; days: number; variationCode: string | null; variationStatus: string | null }[];
  totals: { currency: string; firmCost: string; firmRevenue: string; firmMargin: string; pendingCost: string; pendingRevenue: string; firmDays: number; pendingDays: number }[];
}

/** Değişiklik etki dosyası (öneri 16): onaylı etki kesin, onay bekleyen olası. */
export function ChangeImpactPanel({ projectId }: { projectId: string }) {
  const q = useCQuery<Impact>(['construction', 'change-impact', projectId], `/api/construction/change-impact?projectId=${projectId}`);
  return (
    <Card className="mt-5">
      <CardHeader title="Değişikliklerin maliyet, süre ve gelir etkisi" description="Onaylanmamış değişiklik kesin gelir ya da maliyet sayılmaz; olası etki olarak ayrı gösterilir." />
      <div className="space-y-3 p-5 text-sm">
        {q.error ? <ErrorCallout error={q.error} /> : null}
        {q.data && q.data.items.length === 0 && <p className="text-muted">Değişiklik dosyası yok.</p>}
        {q.data?.totals.map((t) => (
          <p key={t.currency}>
            <span className="font-medium">Kesin ({t.currency}):</span> maliyet {moneyIn(t.firmCost, t.currency)}, gelir {moneyIn(t.firmRevenue, t.currency)}, katkı {moneyIn(t.firmMargin, t.currency)}, {t.firmDays} gün ·{' '}
            <span className="text-muted">
              olası: maliyet {moneyIn(t.pendingCost, t.currency)}, gelir {moneyIn(t.pendingRevenue, t.currency)}, {t.pendingDays} gün
            </span>
          </p>
        ))}
        {q.data && q.data.items.length > 0 && (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Değişiklik</Th>
                  <Th>Durum</Th>
                  <Th num>Maliyet</Th>
                  <Th num>Gelir</Th>
                  <Th num>Gün</Th>
                  <Th>Değişiklik emri</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((i) => (
                  <Tr key={i.id}>
                    <Td>{i.title}</Td>
                    <Td>
                      <Badge tone={i.firm ? 'success' : 'warning'}>{i.firm ? 'Kesin' : 'Olası'}</Badge>
                    </Td>
                    <Td num>{moneyIn(i.cost, i.currency)}</Td>
                    <Td num>{moneyIn(i.revenue, i.currency)}</Td>
                    <Td num>{i.days}</Td>
                    <Td>{i.variationCode ? `${i.variationCode} · ${i.variationStatus}` : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}

interface Diffs {
  withDifference: number;
  items: { id: string; title: string; subcontractCode: string | null; unit: string; date: string; claimed: string; accepted: string; difference: string; note: string | null; transferred: string; remaining: string }[];
}

/** Taşeron ölçüm ve kabul farkı (öneri 88). */
export function MeasurementDiffPanel({ projectId }: { projectId: string }) {
  const q = useCQuery<Diffs>(['construction', 'measurement-diffs', projectId], `/api/construction/measurement-diffs?projectId=${projectId}`);
  if (!q.data || q.data.items.length === 0) return q.error ? <ErrorCallout error={q.error} /> : null;
  return (
    <Card className="mt-5">
      <CardHeader title="Ölçüm ve kabul farkları" description="Hakedişe yalnız ölçümle kabul edilen miktar aktarılır. Kabul miktarı üretim onayında girilir." />
      <div className="p-5">
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Üretim</Th>
                <Th num>Beyan</Th>
                <Th num>Kabul</Th>
                <Th num>Fark</Th>
                <Th num>Hakedişe aktarılan</Th>
                <Th>Gerekçe</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((i) => (
                <Tr key={i.id}>
                  <Td>
                    {i.title} <span className="text-xs text-muted">{i.subcontractCode ?? ''} · {formatDateTR(i.date)}</span>
                  </Td>
                  <Td num>
                    {i.claimed} {i.unit}
                  </Td>
                  <Td num>{i.accepted}</Td>
                  <Td num className={Number(i.difference) !== 0 ? 'text-warning' : ''}>{i.difference}</Td>
                  <Td num>{i.transferred}</Td>
                  <Td className="text-xs">{i.note ?? ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </div>
    </Card>
  );
}
