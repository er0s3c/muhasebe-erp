import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';
import { quantityString } from './schemas/inventory';

export const offlineDraftPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stock_count'), warehouseId: uuid, date: isoDate, description: z.string().trim().max(200),
    lines: z.array(z.object({ itemId: uuid, countedQty: quantityString })).min(1).max(2000) }),
  z.object({ kind: z.literal('field_task'), title: z.string().trim().min(2).max(200), description: z.string().trim().max(4000),
    date: isoDate, priority: z.enum(['normal', 'high']).default('normal') }),
]);
export const offlineDraftSyncSchema = z.object({ clientId: uuid, draft: offlineDraftPayloadSchema });
export type OfflineDraftPayload = z.infer<typeof offlineDraftPayloadSchema>;
export type OfflineDraftSync = z.infer<typeof offlineDraftSyncSchema>;
export type OfflineDraftReceipt = { clientId: string; resultId: string; resultPath: string; replayed: boolean };
export type OfflineDraftBootstrap = { companyId: string; companyName: string; userId: string; branchSelection: string; timeZone: string; today: string;
  kinds: OfflineDraftPayload['kind'][]; warehouses: { id: string; name: string }[];
  items: { id: string; code: string; name: string; unit: string }[]; truncated: boolean };
