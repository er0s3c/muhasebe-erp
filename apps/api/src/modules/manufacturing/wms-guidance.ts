import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { dec, uuid, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute } from '../../http/context';
import { all, fail } from '../leather/common';
import { getRecord } from './service';

/** Parti ya da raftaki kalan miktar (yerleştirme/toplama sonrası güncellenen `remainingQty`, yoksa ilk miktar). */
const remaining = (config: Record<string, unknown>) => dec((config.remainingQty ?? config.quantity ?? 0) as string);

export interface BinSuggestion { binId: string; code: string; name: string; pickSequence: number; free: string | null; quantity: string; reasons: string[] }

/**
 * Yönlendirmeli yerleştirme (öneri 43): partinin rafa konmamış miktarı için sıralı raf önerisi. Yalnız partinin deposundaki
 * etkin ve kartı kabul eden raflar; öncelik aynı kartın zaten bulunduğu raf, sonra miktarın tamamının sığdığı en dar raf
 * (alanı verimli kullanır), sonra toplama sırası. Öneri kayıt yapmaz; yerleştirme kullanıcının onayıyla mevcut uçtan yapılır.
 */
export async function suggestBins(tx: Tx, lotId: string): Promise<{ unplaced: string; suggestions: BinSuggestion[] }> {
  const lot = await getRecord(tx, lotId, 'lot');
  const placed = (await all(tx, sql`select config from manufacturing_records where kind = 'placement' and config->>'lotId' = ${lot.id}`))
    .reduce<MoneyValue>((s, r) => s.plus(remaining(r.config)), dec(0));
  const unplaced = remaining(lot.config).minus(placed);
  if (unplaced.lte(0)) return { unplaced: '0', suggestions: [] };
  const bins = await all(tx, sql`select id, code, config from manufacturing_records where kind = 'bin' and status = 'active' and warehouse_id = ${lot.warehouse_id}::uuid`);
  const placements = await all(tx, sql`select config from manufacturing_records where kind = 'placement' and warehouse_id = ${lot.warehouse_id}::uuid`);
  const ranked = [];
  for (const bin of bins) {
    const allowed = Array.isArray(bin.config.allowedItemIds) ? (bin.config.allowedItemIds as string[]) : [];
    if (allowed.length && !allowed.includes(lot.item_id)) continue;
    const inBin = placements.filter((p) => p.config.binId === bin.id);
    const occupied = inBin.reduce<MoneyValue>((s, p) => s.plus(remaining(p.config)), dec(0));
    const capacity = dec(bin.config.capacity ?? 0);
    const free = capacity.gt(0) ? capacity.minus(occupied) : null;
    if (free && free.lte(0)) continue;
    const sameItem = inBin.some((p) => p.config.itemId === lot.item_id && remaining(p.config).gt(0));
    const fitsAll = !free || free.gte(unplaced);
    const reasons = [
      ...(sameItem ? ['Aynı kart bu rafta'] : []),
      ...(allowed.length ? ['Raf bu kart için ayrılmış'] : []),
      fitsAll ? (free ? `Tamamı sığar (boş ${free.toFixed(0)})` : 'Kapasite sınırı yok') : `Kısmen sığar (boş ${free!.toFixed(0)})`,
    ];
    ranked.push({
      binId: bin.id, code: bin.code, name: String(bin.config.name ?? bin.code), pickSequence: Number(bin.config.pickSequence ?? 0),
      free: free ? free.toFixed(4) : null, quantity: (fitsAll ? unplaced : free!).toFixed(4), reasons,
      score: [sameItem ? 0 : 1, allowed.length ? 0 : 1, fitsAll ? 0 : 1, free ? Number(free.minus(unplaced).abs()) : Number.MAX_SAFE_INTEGER, Number(bin.config.pickSequence ?? 0)],
    });
  }
  ranked.sort((a, b) => { for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return a.score[i]! - b.score[i]!; return a.code.localeCompare(b.code); });
  return { unplaced: unplaced.toFixed(4), suggestions: ranked.slice(0, 5).map(({ score: _score, ...s }) => s) };
}

export interface PickStop { sequence: number; binId: string | null; binCode: string | null; itemId: string; itemCode: string; itemName: string; lotCode: string | null; quantity: string }

/**
 * Sipariş toplama sırası ve güzergâhı (öneri 44): satış irsaliyesinin kalemleri, kartın yerleştirildiği raflardan raf
 * toplama sırasına göre (aynı rafta en eski parti önce) dağıtılır. Rafta bulunmayan miktar "raf dışı" durağında gösterilir.
 * Liste stok hareketi oluşturmaz; çıkış irsaliyenin kendi kaydıyla zaten yapılır.
 */
export async function pickList(tx: Tx, deliveryNoteId: string) {
  const [note] = await all(tx, sql`select id, note_no, type, warehouse_id from delivery_notes where id = ${deliveryNoteId}::uuid`);
  if (!note) throw fail('İrsaliye bulunamadı');
  if (note.type !== 'sales') throw fail('Toplama listesi satış irsaliyesi için hazırlanır');
  const lines = await all(tx, sql`
    select l.item_id, i.code, i.name, sum(l.quantity)::text as quantity
      from delivery_note_lines l join items i on i.id = l.item_id
     where l.note_id = ${note.id}::uuid group by l.item_id, i.code, i.name order by i.code`);
  const stocked = await all(tx, sql`
    select p.config, p.created_at, b.id as bin_id, b.code as bin_code, coalesce((b.config->>'pickSequence')::int, 0) as seq, l.code as lot_code
      from manufacturing_records p
      join manufacturing_records b on b.kind = 'bin' and b.id::text = p.config->>'binId'
      left join manufacturing_records l on l.kind = 'lot' and l.id::text = p.config->>'lotId'
     where p.kind = 'placement' and p.warehouse_id = ${note.warehouse_id}::uuid
     order by seq, b.code, p.created_at, p.id`);
  const stops: PickStop[] = [];
  const shortfalls: { itemCode: string; itemName: string; quantity: string }[] = [];
  for (const line of lines) {
    let need = dec(line.quantity);
    for (const s of stocked.filter((x) => x.config.itemId === line.item_id)) {
      if (need.lte(0)) break;
      const available = remaining(s.config);
      if (available.lte(0)) continue;
      const take = available.lt(need) ? available : need;
      stops.push({ sequence: Number(s.seq), binId: s.bin_id, binCode: s.bin_code, itemId: line.item_id, itemCode: line.code, itemName: line.name, lotCode: s.lot_code ?? null, quantity: take.toFixed(4) });
      need = need.minus(take);
    }
    if (need.gt(0)) shortfalls.push({ itemCode: line.code, itemName: line.name, quantity: need.toFixed(4) });
  }
  stops.sort((a, b) => a.sequence - b.sequence || (a.binCode ?? '').localeCompare(b.binCode ?? '') || a.itemCode.localeCompare(b.itemCode));
  return { note: { id: note.id, noteNo: note.note_no }, stops, shortfalls };
}

export const wmsGuidanceRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'inventory.wms', permission: 'inventory.wms.read' } as const;
  app.get('/api/wms/lots/:id/placement-suggestions', tenantRoute(app, read, async (c) => suggestBins(c.tx, z.object({ id: uuid }).parse(c.req.params).id)));
  app.get('/api/wms/pick-list', tenantRoute(app, read, async (c) => pickList(c.tx, z.object({ deliveryNoteId: uuid }).parse(c.req.query).deliveryNoteId)));
};
