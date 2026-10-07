import { z } from 'zod';
import { dec, tryDec } from './money';
import { isoDate, uuid } from './schemas/common';
import { positiveQuantity, quantityString, unitCostString } from './schemas/inventory';
import { leatherModelSchema, leatherRevisionSchema } from './leather';

const name = z.string().trim().min(1).max(160);
const instant = z.iso.datetime({ offset: true });
export const manufacturingModelSchema = leatherModelSchema.extend({
  family: name.default('Genel üretim'),
});
export const manufacturingRevisionSchema = leatherRevisionSchema
  .extend({
    materials: z
      .array(
        leatherRevisionSchema.shape.materials.element.extend({
          alternatives: z.array(uuid).max(20).default([]),
        }),
      )
      .min(1)
      .max(100),
    byproducts: z
      .array(z.object({ itemId: uuid, quantity: positiveQuantity, costShare: quantityString }))
      .max(20)
      .default([]),
  })
  .refine((r) => {
    const shares = r.byproducts.map((b) => tryDec(b.costShare));
    return shares.every((s) => s !== null) && shares.reduce((sum, s) => sum.plus(s!), dec(0)).lt(1);
  }, 'Yan ürün maliyet payı toplamı 1’den küçük olmalı');
export const manufacturingMrpSchema = z.object({
  itemId: uuid,
  quantity: positiveQuantity,
  warehouseId: uuid,
  dueDate: isoDate.optional(),
});
export const manufacturingResourceSchema = z.object({
  code: name,
  name,
  type: z.enum(['machine', 'person', 'center']),
  capacity: z.number().int().min(1).max(100).default(1),
  standardMinutes: quantityString.default('0'),
  department: z.string().max(160).default(''),
  assetId: uuid.optional(),
  assignedUserId: uuid.optional(),
  employeeId: uuid.optional(),
});
export const manufacturingCalendarSchema = z
  .object({
    resourceId: uuid,
    start: instant,
    end: instant,
    available: z.boolean(),
    reason: z.enum(['shift', 'maintenance', 'breakdown', 'absence', 'overtime']),
  })
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), 'Bitiş başlangıçtan sonra olmalı');
export const manufacturingMaintenanceSchema = z
  .object({
    resourceId: uuid,
    start: instant,
    end: instant,
    kind: z.enum(['planned', 'breakdown']),
    description: name,
    spareParts: z
      .array(z.object({ itemId: uuid, quantity: positiveQuantity }))
      .max(30)
      .default([]),
    warehouseId: uuid.optional(),
  })
  .refine(
    (v) => Date.parse(v.end) > Date.parse(v.start) && (!v.spareParts.length || !!v.warehouseId),
    'Bakım aralığı ve yedek parça deposu gerekli',
  );
export const manufacturingScheduleSchema = z.object({
  direction: z.enum(['forward', 'backward']).default('forward'),
  anchor: instant,
  jobs: z
    .array(
      z.object({
        orderId: uuid,
        operationKey: name,
        resourceId: uuid,
        minutes: z.number().int().min(1).max(525600),
        priority: z.number().int().min(0).max(100).default(0),
        predecessor: name.optional(),
        durationSource: z.enum(['actual', 'standard', 'manual']).optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (jobs) => new Set(jobs.map((j) => j.orderId + ':' + j.operationKey)).size === jobs.length,
      'Operasyon aynı senaryoya bir kez eklenmeli',
    ),
});
export const manufacturingTransferSchema = z
  .object({
    orderId: uuid,
    fromOperation: name,
    toOperation: name,
    quantity: positiveQuantity,
    note: z.string().max(1000).default(''),
  })
  .refine((v) => v.fromOperation !== v.toOperation, 'Farklı operasyonlar seçin');
export const manufacturingTransferActionSchema = z.object({
  action: z.enum(['approve', 'dispatch', 'receive', 'cancel']),
  quantity: positiveQuantity.optional(),
  requestKey: uuid,
});
export const wmsBinSchema = z.object({
  warehouseId: uuid,
  code: name,
  name,
  capacity: quantityString.default('0'),
});
export const wmsLotSchema = z.object({
  itemId: uuid,
  warehouseId: uuid,
  code: name,
  quantity: positiveQuantity,
  status: z.enum(['available', 'quarantine', 'blocked']).default('quarantine'),
  sourceDocumentId: uuid,
  serials: z.array(name).max(1000).default([]),
});
export const wmsPlacementSchema = z.object({
  lotId: uuid,
  binId: uuid,
  quantity: positiveQuantity,
  requestKey: uuid,
});
export const logisticsShipmentSchema = z.object({
  deliveryNoteId: uuid,
  warehouseId: uuid,
  carrier: name,
  vehicle: z.string().max(80).default(''),
  trackingNo: z.string().max(160).default(''),
  packages: z
    .array(
      z.object({
        code: name,
        type: z.enum(['box', 'pallet']),
        lines: z
          .array(z.object({ itemId: uuid, quantity: positiveQuantity }))
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(100),
});
export const integrationConnectionSchema = z
  .object({
    provider: z.enum(['shopify', 'ticimax', 'bank', 'pdks', 'edocument']),
    name,
    endpoint: z.url().optional(),
    token: z.string().min(1).max(4000).optional(),
    shop: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)
      .optional(),
    apiVersion: z
      .string()
      .regex(/^\d{4}-(01|04|07|10)$/)
      .optional(),
  })
  .refine((v) => v.provider !== 'shopify' || !v.token || !!v.shop, 'Shopify mağaza alanı gerekli');
export const manufacturingRecordActionSchema = z.object({
  action: z.enum(['publish', 'complete', 'cancel', 'deliver', 'release', 'block', 'retry']),
  requestKey: uuid,
  date: isoDate.optional(),
});
export const manufacturingDepartmentSchema = z.object({
  code: name,
  name,
  branch: name,
  parentId: uuid.optional(),
});
export const manufacturingCustomFieldSchema = z.object({
  code: name,
  name,
  entity: z.enum(['item', 'model', 'production', 'resource']),
  type: z.enum(['text', 'number', 'date', 'choice']),
  required: z.boolean().default(false),
  choices: z.array(name).max(100).default([]),
});
export const manufacturingCustomValuesSchema = z.object({
  values: z.record(z.string().min(1).max(160), z.string().max(2000)),
});
export const manufacturingPieceRateSchema = z
  .object({
    payrollRunId: uuid,
    payrollItemId: uuid,
    resourceId: uuid,
    operationKey: name,
    unitRate: unitCostString,
    mode: z.enum(['piece', 'hour']).default('piece'),
    requestKey: uuid,
  })
  .refine((v) => tryDec(v.unitRate)?.gt(0) ?? false, 'Birim ücret sıfırdan büyük olmalı');

export interface MrpRecipe {
  itemId: string;
  materials: { itemId: string; quantity: string; wastePct?: string; alternatives?: string[] }[];
}
export interface MrpNeed {
  itemId: string;
  gross: string;
  available: string;
  net: string;
  action: 'produce' | 'purchase';
  parentItemId: string | null;
}
/** Consume each stock balance once across all branches of the BOM. */
export function explodeManufacturingNeed(
  itemId: string,
  quantity: string,
  recipes: readonly MrpRecipe[],
  stock: Readonly<Record<string, string>>,
): MrpNeed[] {
  const byItem = new Map(recipes.map((r) => [r.itemId, r]));
  const available = new Map(
    Object.entries(stock).map(([id, q]) => [id, dec(q).lt(0) ? dec(0) : dec(q)]),
  );
  const needs: MrpNeed[] = [];
  function visit(id: string, gross: string, path: string[], parent: string | null) {
    if (path.includes(id)) throw new Error('Reçete döngüsü: ' + [...path, id].join(' → '));
    if (path.length > 30 || needs.length >= 5000)
      throw new Error('Reçete derinlik/satır sınırı aşıldı');
    const q = dec(gross),
      free = available.get(id) ?? dec(0),
      used = free.lt(q) ? free : q,
      net = q.minus(used);
    available.set(id, free.minus(used));
    const recipe = byItem.get(id);
    needs.push({
      itemId: id,
      gross: q.toFixed(4),
      available: used.toFixed(4),
      net: net.toFixed(4),
      action: recipe ? 'produce' : 'purchase',
      parentItemId: parent,
    });
    if (net.gt(0) && recipe)
      for (const line of recipe.materials)
        visit(
          line.itemId,
          net
            .times(line.quantity)
            .times(dec(1).plus(dec(line.wastePct ?? 0).div(100)))
            .toFixed(4),
          [...path, id],
          id,
        );
  }
  visit(itemId, quantity, [], null);
  return needs;
}

export interface CapacityInterval {
  resourceId: string;
  start: string;
  end: string;
  available: boolean;
}
export interface ScheduledOperation {
  orderId: string;
  operationKey: string;
  resourceId: string;
  start: string;
  end: string;
  minutes: number;
  priority: number;
  predecessor?: string;
  segments?: { start: string; end: string }[];
}
export type SchedulingJob = z.infer<typeof manufacturingScheduleSchema>['jobs'][number];
/** Work spans may cross shifts; only working segments occupy resource capacity. */
export function finiteManufacturingSchedule(
  jobs: readonly SchedulingJob[],
  calendars: readonly CapacityInterval[],
  anchor: string,
  direction: 'forward' | 'backward',
  capacities: Readonly<Record<string, number>> = {},
  occupied: readonly ScheduledOperation[] = [],
): ScheduledOperation[] {
  const ordered = [...jobs].sort((a, b) => b.priority - a.priority);
  const result: ScheduledOperation[] = [];
  const waiting = [...ordered];
  while (waiting.length) {
    const index = waiting.findIndex((j) =>
      direction === 'forward'
        ? !j.predecessor ||
          !waiting.some((p) => p.orderId === j.orderId && p.operationKey === j.predecessor)
        : !waiting.some((p) => p.orderId === j.orderId && p.predecessor === j.operationKey),
    );
    if (index < 0) throw new Error('Operasyon bağımlılık döngüsü');
    const job = waiting.splice(index, 1)[0]!;
    const parent =
      direction === 'forward'
        ? result.find((p) => p.orderId === job.orderId && p.operationKey === job.predecessor)
        : result.find((p) => p.orderId === job.orderId && p.predecessor === job.operationKey);
    if (
      job.predecessor &&
      !jobs.some((p) => p.orderId === job.orderId && p.operationKey === job.predecessor)
    )
      throw new Error('Önceki operasyon bulunamadı');
    let cursor = Math.max(Date.parse(anchor), parent ? Date.parse(parent.end) : 0);
    if (direction === 'backward')
      cursor = Math.min(Date.parse(anchor), parent ? Date.parse(parent.start) : Date.parse(anchor));
    const sign = direction === 'forward' ? 1 : -1;
    let first: number | undefined,
      last: number | undefined,
      count = 0;
    const slots: number[] = [];
    for (
      let scanned = 0;
      scanned < 525600 && count < job.minutes;
      scanned++, cursor += sign * 60000
    ) {
      const t = direction === 'forward' ? cursor : cursor - 60000;
      const relevant = calendars.filter((c) => c.resourceId === job.resourceId);
      const allowed = relevant.some(
        (c) => c.available && Date.parse(c.start) <= t && Date.parse(c.end) >= t + 60000,
      );
      const blocked = relevant.some(
        (c) => !c.available && Date.parse(c.start) < t + 60000 && Date.parse(c.end) > t,
      );
      const busy = [...occupied, ...result].filter(
        (o) =>
          o.resourceId === job.resourceId &&
          (o.segments ?? [o]).some((s) => Date.parse(s.start) < t + 60000 && Date.parse(s.end) > t),
      ).length;
      if (!allowed || blocked || busy >= (capacities[job.resourceId] ?? 1)) continue;
      slots.push(t);
      first = first === undefined ? t : Math.min(first, t);
      last = last === undefined ? t + 60000 : Math.max(last, t + 60000);
      count++;
    }
    if (count !== job.minutes || first === undefined || last === undefined)
      throw new Error('Uygun kapasite bulunamadı');
    const segments: { start: string; end: string }[] = [];
    for (const t of slots.sort((a, b) => a - b)) {
      const previous = segments.at(-1);
      if (previous && Date.parse(previous.end) === t)
        previous.end = new Date(t + 60000).toISOString();
      else
        segments.push({ start: new Date(t).toISOString(), end: new Date(t + 60000).toISOString() });
    }
    result.push({
      ...job,
      start: new Date(first).toISOString(),
      end: new Date(last).toISOString(),
      segments,
    });
  }
  return result;
}
