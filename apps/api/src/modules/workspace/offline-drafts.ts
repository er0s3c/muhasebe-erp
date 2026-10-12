import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { offlineDraftSyncSchema, todayIso, type OfflineDraftBootstrap, type OfflineDraftReceipt } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { conflict, forbidden } from '../../http/errors';
import { isModuleDenied, requireResourceOperation } from '../access/effective';
import { requireOpenPeriod } from '../settings/periods';
import { createStockCount, updateStockCount } from '../inventory/counts';
import { lockItems, loadWarehouseQty } from '../inventory/balances';

const taskWrite = (c: TenantCtx) => Array.from(c.access.permissions).some(permission => !permission.endsWith('.read') && permission !== 'workspace.use' && permission !== 'data.export');
const stockAllowed = (c: TenantCtx) => c.can('inventory.read') && c.can('inventory.move') && c.enabledModules.has('core.inventory') && !isModuleDenied(c.access, 'core.inventory');
const branchSelection = (c: TenantCtx) => c.branch.selection === 'branch' ? c.branch.activeBranchId! : c.branch.selection;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);

export const offlineDraftRoutes: FastifyPluginAsync = async app => {
  const guard = { module: 'core.dashboard', permission: 'workspace.use' } as const;
  app.get('/api/offline-drafts/bootstrap', tenantRoute(app, guard, async c => {
    const kinds: OfflineDraftBootstrap['kinds'] = taskWrite(c) ? ['field_task'] : [];
    let warehouses: OfflineDraftBootstrap['warehouses'] = [], items: OfflineDraftBootstrap['items'] = [];
    let truncated = false;
    if (stockAllowed(c)) {
      try { requireResourceOperation(c.access, 'core.inventory', 'create'); kinds.push('stock_count'); } catch { /* Liste yalnız izin verilen taslak türlerini gösterir. */ }
      if (kinds.includes('stock_count')) {
        warehouses = (await c.tx.execute<{ id: string; name: string }>(sql`select id,name from warehouses where is_active order by name limit 201`)).rows;
        items = (await c.tx.execute<{ id: string; code: string; name: string; unit: string }>(sql`select id,code,name,unit from items where is_active and kind='goods' order by code limit 2001`)).rows;
        truncated = warehouses.length > 200 || items.length > 2000;
        warehouses = warehouses.slice(0, 200); items = items.slice(0, 2000);
      }
    }
    return { companyId: c.company.id, companyName: c.company.name, userId: c.user.id, branchSelection: branchSelection(c), timeZone: c.company.timeZone, today: todayIso(), kinds, warehouses, items, truncated } satisfies OfflineDraftBootstrap;
  }));
  app.post('/api/offline-drafts/sync', tenantRoute(app, { ...guard, limit: { name: 'offline-draft-sync', max: 60, windowMs: 60_000 } }, async c => {
    const input = offlineDraftSyncSchema.parse(c.req.body);
    if (input.draft.kind === 'stock_count') {
      if (!stockAllowed(c)) throw forbidden('Sayım taslağını eşitleme yetkiniz yok.');
      requireResourceOperation(c.access, 'core.inventory', 'create');
    } else if (!taskWrite(c)) throw forbidden('Saha görevi oluşturma yetkiniz yok.');
    const scope = branchSelection(c);
    const requestHash = createHash('sha256').update(canonical({ draft: input.draft, branchSelection: scope })).digest('hex');
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':' + c.user.id + ':' + input.clientId},0))`);
    const prior = (await c.tx.execute<{ requestHash: string; resultId: string; resultPath: string }>(sql`select request_hash as "requestHash",result_id as "resultId",result_path as "resultPath" from offline_draft_receipts where client_id=${input.clientId}::uuid and user_id=${c.user.id}::uuid`)).rows[0];
    if (prior) {
      if (prior.requestHash !== requestHash) throw conflict('Bu eşitleme kimliği farklı bir taslağa veya şube görünümüne ait.', 'OFFLINE_DRAFT_CONFLICT');
      return { clientId: input.clientId, resultId: prior.resultId, resultPath: prior.resultPath, replayed: true } satisfies OfflineDraftReceipt;
    }
    let resultId: string, resultPath: string;
    if (input.draft.kind === 'stock_count') {
      const draft = input.draft;
      await requireOpenPeriod(c.tx, draft.date);
      const ids = draft.lines.map(line => line.itemId);
      await lockItems(c.tx, ids);
      const active = await c.tx.execute(sql`select id from items where id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) and is_active and kind='goods'`);
      if (new Set(ids).size !== ids.length || active.rows.length !== ids.length) throw conflict('Taslakta yinelenen, pasif veya artık erişilemeyen stok kartı var.', 'OFFLINE_STOCK_CHANGED');
      await loadWarehouseQty(c.tx, ids, [draft.warehouseId]);
      const ctx = { companyId: c.company.id, userId: c.user.id, baseCurrency: c.company.baseCurrency, reportingCurrency: c.company.reportingCurrency, allowNegativeStock: c.company.allowNegativeStock };
      const created = await createStockCount(c.tx, ctx, { warehouseId: draft.warehouseId, countDate: draft.date, description: draft.description, prefill: 'empty' });
      resultId = created.count.id;
      await updateStockCount(c.tx, ctx, resultId, { lines: draft.lines, description: draft.description });
      resultPath = `/inventory/counts/${resultId}`;
    } else {
      resultId = uuidv7();
      const draft = input.draft;
      await c.tx.execute(sql`insert into work_items(id,company_id,title,description,due_date,owner_id,created_by,priority) values(${resultId},${c.company.id},${draft.title},${draft.description},${draft.date},${c.user.id},${c.user.id},${draft.priority})`);
      resultPath = `/workspace?task=${resultId}`;
    }
    await c.tx.execute(sql`insert into offline_draft_receipts(id,company_id,user_id,client_id,kind,request_hash,result_id,result_path,branch_selection) values(${uuidv7()},${c.company.id},${c.user.id},${input.clientId},${input.draft.kind},${requestHash},${resultId},${resultPath},${scope})`);
    void c.reply.code(201);
    return { clientId: input.clientId, resultId, resultPath, replayed: false } satisfies OfflineDraftReceipt;
  }));
};
