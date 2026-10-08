import { z } from 'zod';
import { uuid, isoDate } from './schemas/common';
import { positiveQuantity, quantityString, unitCostString } from './schemas/inventory';

const text = z.string().trim().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
export const manufacturingCommandSchema = z.object({ requestKey: uuid, reason: text });
export const manufacturingMaterialHandoffSchema = manufacturingCommandSchema
  .extend({
    action: z.enum(['deliver', 'return']),
    itemId: uuid,
    quantity: positiveQuantity,
    handoffId: uuid.optional(),
    receiverId: uuid.optional(),
    date: isoDate,
  })
  .refine((v) => v.action !== 'return' || !!v.handoffId, 'İade için kaynak teslim kaydı gerekli');
export const manufacturingChannelMappingSchema = manufacturingCommandSchema.extend({
  connectionId: uuid,
  itemId: uuid,
  warehouseId: uuid,
  channelSku: z.string().trim().min(1).max(80),
  inventoryItemId: z
    .string()
    .regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/)
    .optional(),
  locationId: z
    .string()
    .regex(/^gid:\/\/shopify\/Location\/\d+$/)
    .optional(),
  variantId: z.number().int().positive().optional(),
});
export const manufacturingPromiseSchema = z.object({
  salesOrderId: uuid,
  warehouseId: uuid,
  anchor: instant,
});
export const manufacturingAllocationSchema = manufacturingCommandSchema.extend({
  salesOrderLineId: uuid,
  warehouseId: uuid,
  quantity: quantityString,
  priority: z.number().int().min(0).max(100).default(50),
});
export const manufacturingSupplierSchema = manufacturingCommandSchema.extend({
  itemId: uuid,
  partyId: uuid,
  supplierCode: z.string().max(160).default(''),
  leadDays: z.number().int().min(0).max(365).default(0),
  minOrderQty: quantityString.default('0'),
  packQty: positiveQuantity.default('1'),
  unitPrice: unitCostString,
  currency: z.string().length(3),
  preferred: z.boolean().default(false),
});
export const manufacturingDemandPolicySchema = manufacturingCommandSchema.extend({
  itemId: uuid,
  warehouseId: uuid,
  minimum: quantityString,
  target: quantityString,
});
export const manufacturingWorkCommandSchema = manufacturingCommandSchema.extend({
  action: z.enum(['start', 'pause', 'complete']),
  operationKey: text,
  resourceId: uuid.optional(),
  batchId: uuid.optional(),
  date: isoDate,
  quantity: quantityString.default('0'),
  goodQty: quantityString.default('0'),
  scrapQty: quantityString.default('0'),
  reworkQty: quantityString.default('0'),
});
export const manufacturingLifecycleSchema = manufacturingCommandSchema.extend({
  phase: z.enum([
    'material_waiting',
    'ready',
    'paused',
    'quality_waiting',
    'rework',
    'on_hold',
    'closed',
  ]),
});
export const manufacturingBatchSchema = manufacturingCommandSchema.extend({
  orderId: uuid,
  quantity: positiveQuantity,
});
export const manufacturingReworkSchema = manufacturingCommandSchema.extend({
  orderId: uuid,
  qualityCheckId: uuid,
  operationKey: text,
  quantity: positiveQuantity,
  defectCode: text,
});
export const manufacturingReworkResultSchema = manufacturingCommandSchema.extend({
  date: isoDate,
  minutes: positiveQuantity,
  resourceId: uuid,
  passedQty: quantityString,
  scrapQty: quantityString.default('0'),
  secondQty: quantityString.default('0'),
});
export const manufacturingScenarioSchema = manufacturingCommandSchema.extend({
  parentId: uuid,
  anchor: instant.optional(),
  calendarOverrides: z
    .array(z.object({ resourceId: uuid, start: instant, end: instant, available: z.boolean() }))
    .max(100)
    .default([]),
  resourceOverrides: z
    .array(
      z.object({
        resourceId: uuid,
        capacity: z.number().int().min(1).max(100).optional(),
        speedFactor: z.number().min(0.1).max(10).default(1),
        hourlyCost: unitCostString.optional(),
      }),
    )
    .max(100)
    .default([]),
});
export const manufacturingCalendarTemplateSchema = manufacturingCommandSchema
  .extend({
    resourceId: uuid,
    from: isoDate,
    to: isoDate,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    utcOffset: z
      .string()
      .regex(/^[+-](0\d|1[0-4]):[0-5]\d$/)
      .default('+03:00'),
    holidays: z.array(isoDate).max(365).default([]),
  })
  .refine(
    (v) =>
      v.from <= v.to &&
      Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000 &&
      v.startTime < v.endTime,
    'Takvim en fazla bir yıl ve aynı gün içinde geçerli saat aralığı olmalı',
  );
export const manufacturingLotDecisionSchema = manufacturingCommandSchema.extend({
  releasedQty: quantityString,
  damagedQty: quantityString.default('0'),
});
export const manufacturingPatternSchema = manufacturingCommandSchema.extend({
  modelId: uuid,
  code: text,
  name: text,
  area: positiveQuantity,
  direction: z.enum(['any', 'grain']).default('any'),
});
export const manufacturingCutPlanSchema = manufacturingCommandSchema.extend({
  orderId: uuid,
  sets: z.number().int().min(1).max(100000),
  pieces: z.array(uuid).min(1).max(500),
  patterns: z
    .array(z.object({ patternId: uuid, perSet: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(100),
});
export const manufacturingExceptionSchema = manufacturingCommandSchema.extend({
  sourceKey: text,
  assignedUserId: uuid.optional(),
  action: z.enum(['assign', 'resolve', 'reopen']),
});
export const manufacturingServiceTimeSchema = manufacturingCommandSchema.extend({
  serviceId: uuid,
  technicianId: uuid,
  minutes: positiveQuantity,
  date: isoDate,
  hourlyRate: unitCostString.default('0'),
});
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const manufacturingPieceGeometrySchema = manufacturingCommandSchema.extend({
  grainAngle: z.number().int().min(0).max(359),
  outline: z.array(point).min(3).max(100),
  defects: z
    .array(
      z.object({
        code: text,
        kind: z.enum(['hole', 'scratch', 'tone', 'other']),
        points: z.array(point).min(3).max(100),
        note: z.string().max(500).default(''),
      }),
    )
    .max(50)
    .default([]),
});
