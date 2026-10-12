import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { formatTR } from '@erp/shared';
import { useCompanyApi, useCQuery } from '../../lib/queries';

interface Suggestion { binId: string; code: string; name: string; pickSequence: number; free: string | null; quantity: string; reasons: string[] }
interface PickList { note: { id: string; noteNo: string | null }; stops: { sequence: number; binCode: string | null; itemCode: string; itemName: string; lotCode: string | null; quantity: string }[]; shortfalls: { itemCode: string; itemName: string; quantity: string }[] }
const qty = (v: string) => formatTR(v, 4).replace(/,?0+$/, '');

/**
 * Yönlendirmeli yerleştirme ve toplama güzergâhı (öneri 43, 44). Raf önerisi kayıt yapmaz; seçilen öneri mevcut yerleştirme
 * ucuyla kaydedilir. Toplama listesi sevkten önce taslak irsaliye için raf sırasına göre durak verir, stok hareketi oluşturmaz.
 */
export function WmsGuidance({ lots, onPlaced }: { lots: { id: string; code?: unknown }[]; onPlaced: () => void }) {
  const toast = useToast();
  const { call } = useCompanyApi();
  const [lotId, setLotId] = useState('');
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const suggestions = useCQuery<{ unplaced: string; suggestions: Suggestion[] }>(['wms', 'suggest', lotId], lotId ? `/api/wms/lots/${lotId}/placement-suggestions` : null);
  const notes = useCQuery<{ notes: { id: string; noteNo: string | null; partyName: string }[] }>(['wms', 'sales-notes'], '/api/delivery-notes?type=sales&status=draft&limit=100');
  const pick = useCQuery<PickList>(['wms', 'pick', noteId], noteId ? `/api/wms/pick-list?deliveryNoteId=${noteId}` : null);
  const place = async (s: Suggestion) => {
    setBusy(s.binId);
    try {
      await call('/api/wms/placements', { method: 'POST', body: { lotId, binId: s.binId, quantity: s.quantity, requestKey: crypto.randomUUID() } });
      toast.success(`${s.code} rafına yerleştirildi`);
      onPlaced();
      void suggestions.refetch();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Yerleştirilemedi'); } finally { setBusy(null); }
  };
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <section aria-label="Raf önerisi" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Raf önerisi</h3>
          <Select aria-label="Parti" value={lotId} onChange={(e) => setLotId(e.target.value)}>
            <option value="">Parti seçin</option>
            {lots.map((l) => <option key={l.id} value={l.id}>{String(l.code ?? l.id)}</option>)}
          </Select>
          {suggestions.error && <ErrorCallout error={suggestions.error} />}
          {suggestions.data && (dec0(suggestions.data.unplaced)
            ? <p className="text-sm text-muted">Partinin tamamı rafa yerleştirilmiş.</p>
            : <>
              <p className="text-xs text-muted">Rafa konmamış: {qty(suggestions.data.unplaced)}</p>
              {suggestions.data.suggestions.length === 0 && <p className="text-sm text-muted">Uygun raf yok: kapasite dolu ya da raflar başka kartlara ayrılmış.</p>}
              <ol className="flex flex-col gap-2">
                {suggestions.data.suggestions.map((s, i) => (
                  <li key={s.binId} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                    <span><span className="font-medium">{i + 1}. {s.code}</span> · {qty(s.quantity)} <span className="block text-xs text-muted">{s.reasons.join(' · ')}</span></span>
                    <Button size="sm" loading={busy === s.binId} onClick={() => void place(s)}>Yerleştir</Button>
                  </li>
                ))}
              </ol>
            </>)}
        </section>
      </Card>
      <Card className="p-4">
        <section aria-label="Toplama listesi" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Toplama listesi</h3>
          <Select aria-label="Satış irsaliyesi" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">Satış irsaliyesi seçin</option>
            {(notes.data?.notes ?? []).map((n) => <option key={n.id} value={n.id}>{n.noteNo ?? 'Taslak irsaliye'} · {n.partyName}</option>)}
          </Select>
          {pick.error && <ErrorCallout error={pick.error} />}
          {pick.data && <>
            <ol className="flex flex-col gap-1.5 text-sm">
              {pick.data.stops.map((s, i) => (
                <li key={i} className="flex justify-between gap-3 border-b border-border pb-1.5"><span><span className="font-mono">{s.binCode}</span> · {s.itemName}{s.lotCode ? ` · ${s.lotCode}` : ''}</span><span className="num">{qty(s.quantity)}</span></li>
              ))}
            </ol>
            {pick.data.shortfalls.length > 0 && <p className="text-xs text-warning">Rafta bulunmayan: {pick.data.shortfalls.map((s) => `${s.itemName} ${qty(s.quantity)}`).join(', ')}</p>}
          </>}
        </section>
      </Card>
    </div>
  );
}

const dec0 = (v: string) => Number(v) <= 0;
