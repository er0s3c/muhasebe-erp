import { sql } from 'drizzle-orm';
import { hasPermission, type FullDataQuery, type Permission } from '@erp/shared';
import type { BuildCtx } from './builders';
import type { CellValue, ReportTable, TableColumn } from '../../files/table';
import { unprocessable } from '../../http/errors';
import { posSaleScope } from '../pos/scope';
import { LEATHER_CONFIDENTIAL_COST_KEYS, LEATHER_CONFIDENTIAL_TRACE_KEYS, productionOrderScope, redactLeatherCosts } from '../leather/visibility';

interface DataSet {
  table: string;
  title: string;
  module: string;
  permission: Permission;
  fields: string;
  costs?: string;
  date?: string;
}

/** Explicit export catalog; secrets, request hashes and uncontrolled JSON never enter a workbook. */
export const LEATHER_DATA_SETS: readonly DataSet[] = [
  { table: 'leather_models', title: 'Deri modelleri', module: 'leather.catalog', permission: 'leather.catalog.read', fields: 'id code name family description created_at' },
  { table: 'leather_revisions', title: 'Deri reçete revizyonları', module: 'leather.catalog', permission: 'leather.catalog.read', fields: 'id model_id revision status config approved_by approved_at created_at' },
  { table: 'leather_variants', title: 'Deri varyantları', module: 'leather.catalog', permission: 'leather.catalog.read', fields: 'id model_id revision_id item_id config created_at' },
  { table: 'leather_lots', title: 'Deri partileri', module: 'leather.materials', permission: 'leather.materials.read', fields: 'id code item_id warehouse_id party_id delivery_note_id delivery_line_id date total_area', costs: 'provisional_value config', date: 'date' },
  { table: 'leather_pieces', title: 'Deri parçaları', module: 'leather.materials', permission: 'leather.materials.read', fields: 'id lot_id item_id warehouse_id parent_id code area remaining_area usable_area status config created_at' },
  { table: 'leather_piece_events', title: 'Deri parça izleri', module: 'leather.materials', permission: 'leather.materials.read', fields: 'id piece_id order_id document_id date kind quantity', date: 'date' },
  { table: 'leather_production_orders', title: 'Deri üretim emirleri', module: 'leather.production', permission: 'leather.production.read', fields: 'id code variant_id revision_id item_id warehouse_id output_warehouse_id quantity completed_qty status due_date config created_at', costs: 'wip_value', date: 'created_at' },
  { table: 'leather_reservations', title: 'Deri rezervasyonları', module: 'leather.production', permission: 'leather.production.read', fields: 'id order_id item_id piece_id warehouse_id quantity consumed_qty status created_at', date: 'created_at' },
  { table: 'leather_production_documents', title: 'Deri üretim fişleri', module: 'leather.production', permission: 'leather.production.read', fields: 'id order_id kind date quantity stock_document_id journal_entry_id request_key', costs: 'value config', date: 'date' },
  { table: 'leather_quality_checks', title: 'Deri kalite kontrolleri', module: 'leather.quality', permission: 'leather.quality.read', fields: 'id scope source_id stage inspected_qty passed_qty status config approved_by approved_at created_at', date: 'created_at' },
  { table: 'leather_subcontract_jobs', title: 'Deri fason işleri', module: 'leather.subcontracting', permission: 'leather.subcontracting.read', fields: 'id order_id party_id operation_key quantity returned_qty status due_date created_at', costs: 'config', date: 'created_at' },
  { table: 'leather_custom_orders', title: 'Deri özel siparişleri', module: 'leather.catalog', permission: 'leather.catalog.read', fields: 'id party_id variant_id quantity due_date status deposit_transaction_id invoice_id config created_at', date: 'created_at' },
  { table: 'leather_deposit_settlements', title: 'Deri kapora mahsupları', module: 'leather.catalog', permission: 'ledger.read', fields: 'id custom_order_id party_id deposit_transaction_id invoice_id charge_line_id settle_line_id entry_id amount amount_base created_at', date: 'created_at' },
  { table: 'leather_service_cases', title: 'Deri servis kayıtları', module: 'leather.service', permission: 'leather.service.read', fields: 'id party_id item_id invoice_line_id serial_id date status invoice_id config', date: 'date' },
  { table: 'leather_cost_roots', title: 'Deri maliyet kaynakları', module: 'leather.production', permission: 'leather.costs.read', fields: 'id source_type source_id line_no kind item_id order_id quantity provisional_value current_value settled_qty settled_provisional accrued config created_at', date: 'created_at' },
  { table: 'leather_cost_shares', title: 'Deri maliyet payları', module: 'leather.production', permission: 'leather.costs.read', fields: 'id root_id target_key target_kind target_id item_id warehouse_id order_id share config' },
  { table: 'leather_cost_events', title: 'Deri maliyet izleri', module: 'leather.production', permission: 'leather.costs.read', fields: 'id root_id source_key from_key to_key share value date config', date: 'date' },
  { table: 'leather_cost_corrections', title: 'Deri maliyet düzeltmeleri', module: 'leather.production', permission: 'leather.costs.read', fields: 'id root_id source_key date amount journal_entry_id stock_document_id config', date: 'date' },
  { table: 'leather_cost_allocations', title: 'Deri maliyet dağıtımları', module: 'leather.production', permission: 'leather.costs.read', fields: 'id order_id receipt_line_id root_id source_journal_line_id amount kind date request_key config', date: 'date' },
  { table: 'pos_tills', title: 'POS kasaları', module: 'sales.pos', permission: 'pos.read', fields: 'id name warehouse_id cash_account_id card_account_id walk_in_party_id currency_code max_discount_pct assigned_user_ids is_active created_at' },
  { table: 'pos_sessions', title: 'POS kasa oturumları', module: 'sales.pos', permission: 'pos.read', fields: 'id till_id user_id status opening_cash expected_cash counted_cash variance close_reason opened_at closed_at', date: 'opened_at' },
  { table: 'pos_sales', title: 'POS satış ve iadeleri', module: 'sales.pos', permission: 'pos.read', fields: 'id session_id invoice_id source_sale_id kind total payments created_by created_at', date: 'created_at' },
  { table: 'purchase_requests', title: 'Satın alma talepleri', module: 'core.procurement', permission: 'procurement.read', fields: 'id code title project_id requested_by need_date status note rejection_note submitted_at created_at', date: 'created_at' },
  { table: 'purchase_request_lines', title: 'Satın alma talep satırları', module: 'core.procurement', permission: 'procurement.read', fields: 'id request_id line_no project_id wbs_id item_id description unit quantity est_unit_price' },
  { table: 'rfqs', title: 'Tedarik teklif dosyaları', module: 'core.procurement', permission: 'procurement.read', fields: 'id code request_id status due_date note awarded_offer_id created_at', date: 'created_at' },
  { table: 'rfq_offers', title: 'Tedarik teklifleri', module: 'core.procurement', permission: 'procurement.read', fields: 'id rfq_id party_id currency_code delivery_days payment_days note created_at', date: 'created_at' },
  { table: 'rfq_offer_lines', title: 'Tedarik teklif satırları', module: 'core.procurement', permission: 'procurement.read', fields: 'id offer_id request_line_id unit_price' },
  { table: 'purchase_orders', title: 'Satın alma siparişleri', module: 'core.procurement', permission: 'procurement.read', fields: 'id code project_id party_id request_id offer_id currency_code vat_code vat_rate payment_days delivery_location status note cancel_reason issued_at created_at', date: 'created_at' },
  { table: 'purchase_order_lines', title: 'Satın alma sipariş satırları', module: 'core.procurement', permission: 'procurement.read', fields: 'id order_id line_no project_id wbs_id request_line_id item_id description unit quantity unit_price' },
];

const LABELS: Record<string, string> = { id: 'Kayıt kimliği', code: 'Kod', name: 'Ad', family: 'Ürün ailesi', description: 'Açıklama', status: 'Durum', date: 'Tarih', due_date: 'Teslim tarihi', quantity: 'Miktar', config: 'Ayrıntılar (JSON)', created_at: 'Oluşturulma', created_by: 'Oluşturan', revision: 'Revizyon', unit: 'Birim', title: 'Başlık', notes: 'Notlar', line_no: 'Satır', total: 'Toplam', amount: 'Tutar', value: 'Değer', provisional_value: 'Geçici maliyet', current_value: 'Güncel maliyet', wip_value: 'Yarı mamul maliyeti', remaining_area: 'Kalan alan', usable_area: 'Kullanılabilir alan', area: 'Alan', total_area: 'Toplam alan', payments: 'Ödemeler (JSON)', opened_at: 'Açılış', closed_at: 'Kapanış', opening_cash: 'Açılış nakdi', expected_cash: 'Beklenen nakit', counted_cash: 'Sayılan nakit', variance: 'Fark', close_reason: 'Kapanış açıklaması', completed_qty: 'Tamamlanan miktar', consumed_qty: 'Tüketilen miktar', inspected_qty: 'İncelenen miktar', passed_qty: 'Uygun miktar', returned_qty: 'Dönen miktar', received_qty: 'Teslim alınan miktar', unit_price: 'Birim fiyat', est_unit_price: 'Tahmini birim fiyat', estimated_total: 'Tahmini toplam', order_date: 'Sipariş tarihi', expected_date: 'Beklenen tarih', deadline: 'Son teklif tarihi', currency_code: 'Para birimi' };
const MONEY = new Set(['total','amount','amount_base','value','provisional_value','current_value','wip_value','settled_provisional','opening_cash','expected_cash','counted_cash','variance','unit_price','est_unit_price','estimated_total']);

export async function leatherDataTables(ctx: BuildCtx, q: FullDataQuery, maxRows: number): Promise<ReportTable[]> {
  if (!ctx.access) return [];
  const { permissions, enabledModules } = ctx.access;
  const costRead = (hasPermission(permissions, 'leather.costs.read') && enabledModules.has('leather.production')) || (hasPermission(permissions,'manufacturing.costs.read') && enabledModules.has('manufacturing.production'));
  const managePos = hasPermission(permissions, 'pos.manage');
  const tables: ReportTable[] = [];
  for (const def of LEATHER_DATA_SETS) {
    const moduleOpen = enabledModules.has(def.module) || (def.module === 'core.procurement' && enabledModules.has('construction.procurement'));
    const common=['leather.catalog','leather.production','leather.quality','leather.subcontracting'].includes(def.module);
    const genericOpen=common&&enabledModules.has(def.module.replace('leather.','manufacturing.'))&&hasPermission(permissions,def.permission.replace('leather.','manufacturing.') as never);
    if ((!moduleOpen || !hasPermission(permissions, def.permission))&&!genericOpen) continue;
    const isLeather = def.table.startsWith('leather_');
    const fields = `${def.fields}${costRead && def.costs ? ' ' + def.costs : ''}`.split(' ')
      .filter(f => costRead || !isLeather || (!LEATHER_CONFIDENTIAL_COST_KEYS.has(f) && !LEATHER_CONFIDENTIAL_TRACE_KEYS.has(f)));
    const dates = new Set(fields.filter(f => f === 'date' || f.endsWith('_date') || f.endsWith('_at')));
    const scope = def.table === 'leather_production_orders' ? productionOrderScope(ctx.user?.role, ctx.user?.id, 'r') :
      ['leather_reservations', 'leather_production_documents'].includes(def.table) ? sql`exists(select 1 from leather_production_orders po where po.id=r.order_id and ${productionOrderScope(ctx.user?.role, ctx.user?.id, 'po')})` :
      def.table === 'pos_sales' ? posSaleScope(ctx.user?.id, managePos, 'r') :
      def.table === 'pos_tills' && !managePos ? (ctx.user ? sql`r.assigned_user_ids @> ${JSON.stringify([ctx.user.id])}::jsonb` : sql`false`) :
      def.table === 'pos_sessions' && !managePos ? (ctx.user ? sql`r.user_id=${ctx.user.id}::uuid and exists(select 1 from pos_tills pt where pt.id=r.till_id and pt.assigned_user_ids @> ${JSON.stringify([ctx.user.id])}::jsonb)` : sql`false`) : sql`true`;
    const date = def.date ? sql`r.${sql.identifier(def.date)}::date` :
      def.table === 'purchase_request_lines' ? sql`(select p.created_at::date from purchase_requests p where p.id=r.request_id)` :
      def.table === 'purchase_order_lines' ? sql`(select p.created_at::date from purchase_orders p where p.id=r.order_id)` :
      def.table === 'rfq_offer_lines' ? sql`(select p.created_at::date from rfq_offers p where p.id=r.offer_id)` : null;
    const result = await ctx.tx.execute<Record<string, unknown>>(sql`select ${sql.join(fields.map(f => sql`r.${sql.identifier(f)}::text as ${sql.identifier(f)}`), sql`, `)} from ${sql.identifier(def.table)} r
      where ${scope} ${date && q.from ? sql`and ${date}>=${q.from}::date` : sql``} ${date && q.to ? sql`and ${date}<=${q.to}::date` : sql``}
      order by r.id limit ${maxRows + 1}`);
    if (result.rows.length > maxRows) throw unprocessable(`“${def.title}” sayfası satır sınırını aşıyor; tarih aralığıyla daraltın.`, 'EXPORT_TOO_LARGE');
    if (!result.rows.length) continue;
    const columns: TableColumn[] = fields.map(f => ({ key: f, label: LABELS[f] ?? f.replaceAll('_', ' '), kind: MONEY.has(f) ? 'money' : dates.has(f) ? (f.endsWith('_at') ? 'text' : 'date') : f === 'line_no' || f === 'revision' ? 'int' : /(?:_qty|_area)$/.test(f) || ['quantity','area'].includes(f) ? 'qty' : 'text', width: f === 'config' ? 40 : 20 }));
    const rows: Record<string, CellValue>[] = result.rows.map(r => Object.fromEntries(fields.map(f => {
      if (r[f] == null) return [f, null];
      if (f === 'config' && isLeather && !costRead) {
        const payload: unknown = JSON.parse(String(r[f]));
        return [f, JSON.stringify(redactLeatherCosts(payload))];
      }
      return [f, String(r[f])];
    })));
    tables.push({ key: def.table, sheet: def.title, title: def.title, subtitle: ctx.company.name, columns, rows });
  }
  return tables;
}
