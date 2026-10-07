import { inArray } from 'drizzle-orm';
import { type AccountMappingKey, type InventoryRole } from '@erp/shared';
import type { Tx } from '../../db/client';
import { items } from '../../db/schema';
import { requireMappings } from '../ledger/mappings';

export function inventoryMappingKey(role: InventoryRole | string): AccountMappingKey {
  return role === 'raw_material' ? 'raw_material_stock' : role === 'semi_finished' ? 'semi_finished_stock' : role === 'finished_goods' ? 'finished_goods_stock' : 'stock';
}
export async function requireItemMappings(tx: Tx, ids: readonly string[]): Promise<Map<string, {stockAccountId:string;cogsAccountId:string}>> {
  const rows=ids.length?await tx.select({id:items.id,role:items.inventoryRole}).from(items).where(inArray(items.id,[...new Set(ids)])):[];
  const keys=new Set<AccountMappingKey>();
  for(const item of rows){keys.add(inventoryMappingKey(item.role));keys.add(item.role==='finished_goods'?'produced_cogs':'cogs');}
  const mapped=await requireMappings(tx,[...keys]);
  return new Map(rows.map(item=>[item.id,{stockAccountId:mapped[inventoryMappingKey(item.role)]!,cogsAccountId:mapped[item.role==='finished_goods'?'produced_cogs':'cogs']!}]));
}
