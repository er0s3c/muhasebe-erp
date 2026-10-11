import { z } from 'zod';
import { isoDate, uuid, moneyString, currencyCode } from './schemas/common';
import { dec } from './money';
const note = z.string().trim().max(4000).default('');
const text = z.string().trim().min(1).max(300);
const qty = z.coerce.number().finite().min(0).max(1e12);
const positive = qty.refine((v) => v > 0, 'Miktar sıfırdan büyük olmalı.');
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const refs = z.array(uuid).max(100).default([]);
const devices = z
  .array(z.object({ name: text, serial: text, warrantyEnd: isoDate, documentIds: refs }))
  .min(1)
  .max(100);
const dateRange = { start: isoDate, end: isoDate };
const range = <T extends { start: string; end: string }>(v: T) => v.end >= v.start;
export const HANDOVER_STAGES = ['pre_inspection', 'snag_fix', 'reinspection', 'customer_walkthrough'] as const;
export type HandoverStage = (typeof HANDOVER_STAGES)[number];
export const WORKFLOW_PAYLOADS = {
  calendar: z.object({
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    holidays: z.array(isoDate).max(366).default([]),
    /** Ekip kapasitesi (öneri 87): program işlerinin ekip ihtiyacı bu sınırla dengelenir. */
    crews: z.array(z.object({ name: text, size: z.coerce.number().int().min(1).max(10000) })).max(50).default([]),
  }),
  baseline: z.object({ note, snapshot: z.array(z.unknown()).max(5000).default([]) }),
  readiness: z.object({
    activityId: uuid,
    drawingReady: z.boolean(),
    materialReady: z.boolean(),
    crewReady: z.boolean(),
    approvalReady: z.boolean(),
    blocker: note,
  }),
  permit: z
    .object({
      type: z.enum(['hot_work', 'height', 'excavation']),
      ...dateRange,
      checklist: z
        .array(z.object({ label: text, checked: z.boolean() }))
        .min(1)
        .max(50),
      procedure: text,
    })
    .refine(range, 'Bitiş başlangıçtan önce olamaz.'),
  takeoff: z.object({
    drawingId: uuid,
    page: z.coerce.number().int().min(1).max(10000),
    kind: z.enum(['length', 'area', 'count']),
    points: z.array(point).min(1).max(1000),
    pageWidth: positive,
    pageHeight: positive,
    unitsPerPixel: positive,
    unit: text,
  }),
  production: z.object({
    subcontractId: uuid,
    lineKey: uuid,
    quantity: positive,
    plannedQuantity: positive,
    unit: text,
    crew: text,
    date: isoDate,
    photoIds: refs,
  }),
  concrete: z.object({
    supplierId: uuid,
    batchNo: text,
    deliveryId: uuid.optional(),
    quantity: positive,
    date: isoDate,
    samples: z
      .array(
        z.object({ name: text, testDate: isoDate, strength: qty.nullable(), minimum: positive }),
      )
      .min(1)
      .max(100),
  }),
  submittal: z.object({
    itemId: uuid.optional(),
    supplierId: uuid,
    brand: text,
    revision: text,
    assetIds: z.array(uuid).min(1).max(30),
    orderId: uuid.optional(),
  }),
  reservation: z
    .object({ equipmentId: uuid, ...dateRange, purpose: text })
    .refine(range, 'Bitiş başlangıçtan önce olamaz.'),
  maintenance: z
    .object({
      equipmentId: uuid,
      dueDate: isoDate,
      dueHours: qty.optional(),
      work: text,
      parts: note,
      outageStart: isoDate.optional(),
      outageEnd: isoDate.optional(),
    })
    .refine(
      (v) => !v.outageEnd || (!!v.outageStart && v.outageEnd >= v.outageStart),
      'Kullanılamama bitişi başlangıçtan önce olamaz ve başlangıç gerektirir.',
    ),
  rate_analysis: z.object({
    unit: text,
    currency: currencyCode,
    validFrom: isoDate,
    components: z
      .array(
        z.object({
          name: text,
          kind: z.enum(['material', 'labor', 'equipment']),
          quantity: positive,
          unitPrice: moneyString,
          source: text,
        }),
      )
      .min(1)
      .max(100),
  }),
  tender: z.object({
    clientId: uuid,
    currency: currencyCode,
    dueDate: isoDate,
    revision: text,
    previousId: uuid.optional(),
    lines: z
      .array(
        z.object({
          description: text,
          unit: text,
          quantity: positive,
          unitPrice: moneyString,
          analysisId: uuid.optional(),
        }),
      )
      .min(1)
      .max(300),
    marginPct: z.coerce.number().min(0).max(100),
    note,
  }),
  material_need: z.object({
    itemId: uuid,
    activityId: uuid.optional(),
    takeoffId: uuid.optional(),
    quantityPerUnit: positive.optional(),
    quantity: positive,
    reserveQuantity: qty.default(0),
    needDate: isoDate,
    leadDays: z.coerce.number().int().min(0).max(730),
    unit: text,
  }),
  change_event: z.object({
    operationId: uuid,
    subcontractId: uuid,
    costImpact: moneyString,
    revenueImpact: moneyString,
    currency: currencyCode,
    days: z.coerce.number().int().min(0).max(3650),
    reason: z.enum([
      'client_request',
      'design_change',
      'site_condition',
      'omission_error',
      'other',
    ]),
    evidenceIds: refs,
    description: text,
  }),
  delay_claim: z
    .object({
      activityIds: z.array(uuid).min(1).max(100),
      ...dateRange,
      requestedDays: z.coerce.number().int().min(1).max(3650),
      reason: text,
      evidence: z
        .array(z.object({ date: isoDate, description: text, assetId: uuid.optional() }))
        .min(1)
        .max(100),
    })
    .refine(range, 'Bitiş başlangıçtan önce olamaz.'),
  forecast: z.object({
    date: isoDate,
    remainingEstimate: moneyString,
    reason: text,
    actual: moneyString.optional(),
    eac: moneyString.optional(),
    budget: moneyString.optional(),
  }),
  feasibility: z
    .object({
      currency: currencyCode,
      landCost: moneyString,
      ownerSharePct: z.coerce.number().min(0).max(100),
      sellableArea: positive,
      salePerM2: moneyString,
      costPerM2: moneyString,
      otherCosts: moneyString,
      stages: z
        .array(
          z.object({
            name: text,
            date: isoDate,
            salePct: z.coerce.number().min(0).max(100),
            costPct: z.coerce.number().min(0).max(100),
          }),
        )
        .min(1)
        .max(60),
    })
    .refine(
      (v) =>
        Math.abs(v.stages.reduce((s, x) => s + x.salePct, 0) - 100) < 0.001 &&
        Math.abs(v.stages.reduce((s, x) => s + x.costPct, 0) - 100) < 0.001,
      'Etap satış ve maliyet dağılımları %100 olmalı.',
    ),
  lead: z.object({
    name: text,
    phone: z.string().trim().max(80).default(''),
    source: text,
    unitId: uuid.optional(),
    reservationUntil: isoDate.optional(),
    partyId: uuid.optional(),
    offerAmount: moneyString.optional(),
    currency: currencyCode,
    contractId: uuid.optional(),
  }),
  buyer_option: z.object({
    unitId: uuid,
    contractId: uuid,
    category: text,
    choice: text,
    price: moneyString,
    currency: currencyCode,
    selectionDeadline: isoDate,
    customerAcceptance: text,
    itemId: uuid.optional(),
  }),
  warranty: z.object({
    unitId: uuid,
    contractId: uuid,
    description: text,
    photoIds: refs,
    appointment: isoDate.optional(),
    contractorId: uuid.optional(),
    coverage: z.enum(['pending', 'covered', 'excluded']).default('pending'),
    customerConfirmation: note,
  }),
  passport: z.object({ unitId: uuid, contractId: uuid, devices, maintenance: note }),
  /** Teslim öncesi aşamalı kontrol (öneri 91): ön kontrol → eksik giderme → yeniden kontrol → müşteriyle gezi. */
  handover_check: z.object({
    unitId: uuid,
    stage: z.enum(HANDOVER_STAGES),
    items: z.array(z.object({ label: text, ok: z.boolean(), note })).min(1).max(200),
    photoIds: refs,
  }),
} as const;
export const WORKFLOW_KINDS = Object.keys(WORKFLOW_PAYLOADS) as (keyof typeof WORKFLOW_PAYLOADS)[];
export type WorkflowKind = keyof typeof WORKFLOW_PAYLOADS;
export type WorkflowPayload<K extends WorkflowKind> = z.infer<(typeof WORKFLOW_PAYLOADS)[K]>;
export const workflowSchema = z.object({
  id: uuid.optional(),
  projectId: uuid,
  kind: z.enum(WORKFLOW_KINDS),
  title: z.string().trim().min(2).max(200),
  locationId: uuid.nullable().default(null),
  wbsId: uuid.nullable().default(null),
  ownerId: uuid.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export interface ConstructionWorkflow {
  id: string;
  projectId: string;
  kind: WorkflowKind;
  title: string;
  locationId: string | null;
  wbsId: string | null;
  ownerId: string;
  status: string;
  version: number;
  payload: Record<string, unknown>;
  computed: Record<string, unknown>;
  linkedKind: string | null;
  linkedId: string | null;
  createdAt: string;
}
export const WORKFLOW_LABELS: Record<WorkflowKind, string> = {
  calendar: 'Çalışma takvimi',
  baseline: 'Başlangıç planı',
  readiness: 'Üç haftalık hazırlık',
  permit: 'Çalışma izinleri',
  takeoff: 'Dijital metraj',
  production: 'Üretim ve hakediş',
  concrete: 'Beton ve numune',
  submittal: 'Malzeme / numune onayı',
  reservation: 'Ekipman rezervasyonu',
  maintenance: 'Bakım işleri',
  rate_analysis: 'Birim fiyat analizi',
  tender: 'İhale ve teklif',
  material_need: 'Malzeme ihtiyaç planı',
  change_event: 'Değişiklik etki dosyası',
  delay_claim: 'Süre uzatımı dosyası',
  forecast: 'Maliyet tahmin defteri',
  feasibility: 'Arsa fizibilitesi',
  lead: 'Konut satış CRM',
  buyer_option: 'Daire seçenekleri',
  warranty: 'Garanti ve servis',
  passport: 'Dijital daire pasaportu',
  handover_check: 'Teslim öncesi kontrol',
};
export const WORKFLOW_GROUPS: Record<
  WorkflowKind,
  'drawings' | 'field' | 'program' | 'commercial' | 'customer'
> = {
  calendar: 'program',
  baseline: 'program',
  readiness: 'program',
  permit: 'field',
  takeoff: 'drawings',
  production: 'field',
  concrete: 'field',
  submittal: 'field',
  reservation: 'program',
  maintenance: 'program',
  rate_analysis: 'commercial',
  tender: 'commercial',
  material_need: 'commercial',
  change_event: 'commercial',
  delay_claim: 'commercial',
  forecast: 'commercial',
  feasibility: 'customer',
  lead: 'customer',
  buyer_option: 'customer',
  warranty: 'customer',
  passport: 'customer',
  handover_check: 'customer',
};
export function analyzeUnitRate(v: WorkflowPayload<'rate_analysis'>) {
  return {
    unitPrice: v.components
      .reduce((s, c) => s.plus(dec(c.quantity).times(c.unitPrice)), dec(0))
      .toFixed(4),
    currency: v.currency,
  };
}
export function analyzeFeasibility(v: WorkflowPayload<'feasibility'>) {
  const revenue = dec(v.sellableArea)
    .times(v.salePerM2)
    .times(dec(100).minus(v.ownerSharePct))
    .div(100);
  const construction = dec(v.sellableArea).times(v.costPerM2).plus(v.otherCosts);
  const total = construction.plus(v.landCost);
  let cash = dec(v.landCost).neg(),
    gap = cash.neg();
  const stages = [...v.stages]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => {
      cash = cash
        .plus(revenue.times(s.salePct).div(100))
        .minus(construction.times(s.costPct).div(100));
      if (cash.neg().gt(gap)) gap = cash.neg();
      return { ...s, balance: cash.toFixed(2) };
    });
  return {
    revenue: revenue.toFixed(2),
    totalCost: total.toFixed(2),
    profit: revenue.minus(total).toFixed(2),
    fundingNeed: gap.toFixed(2),
    currency: v.currency,
    stages,
  };
}

export interface CalendarActivity {
  id: string;
  title: string;
  start: string;
  end: string;
  progress: number;
  dependencies: string[];
  milestone?: boolean;
  wbsId?: string | null;
  /** Ekip ve kişi sayısı (öneri 87). */
  crew?: string;
  crewSize?: number;
}
export function criticalPath(
  activities: CalendarActivity[],
  weekdays: number[] = [1, 2, 3, 4, 5],
  holidays: string[] = [],
) {
  if (!weekdays.length) throw new Error('En az bir çalışma günü gerekir.');
  const holiday = new Set(holidays),
    byId = new Map(activities.map((a) => [a.id, a]));
  const working = (date: string) =>
    weekdays.includes(new Date(date + 'T12:00:00Z').getUTCDay()) && !holiday.has(date);
  const day = (date: string, n: number) => {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const add = (date: string, n: number) => {
    let d = date;
    for (let guard = 0; guard < 20000; guard++) {
      if (working(d)) {
        if (n === 0) return d;
        n--;
      }
      d = day(d, 1);
    }
    throw new Error('Takvim hesaplama sınırı aşıldı.');
  };
  const ordered: CalendarActivity[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (a: CalendarActivity) => {
    if (visiting.has(a.id)) throw new Error('Programda bağımlılık döngüsü var.');
    if (visited.has(a.id)) return;
    visiting.add(a.id);
    for (const id of a.dependencies) {
      const p = byId.get(id);
      if (!p) throw new Error('Program bağımlılığı bulunamadı.');
      visit(p);
    }
    visiting.delete(a.id);
    visited.add(a.id);
    ordered.push(a);
  };
  activities.forEach(visit);
  const computed = new Map<
    string,
    { start: string; end: string; duration: number; longest: number }
  >();
  for (const a of ordered) {
    let duration = 0;
    for (let d = a.start, guard = 0; d <= a.end; d = day(d, 1)) {
      if (++guard > 20000) throw new Error('İş süresi çok uzun.');
      if (working(d)) duration++;
    }
    duration = a.milestone ? 0 : Math.max(1, duration);
    let start = add(a.start, 0),
      longest = 0;
    for (const id of a.dependencies) {
      const p = computed.get(id)!;
      const earliest = add(day(p.end, p.duration === 0 ? 0 : 1), 0);
      if (earliest > start) start = earliest;
      longest = Math.max(longest, p.longest);
    }
    computed.set(a.id, {
      start,
      end: add(start, Math.max(0, duration - 1)),
      duration,
      longest: longest + duration,
    });
  }
  // Backward pass: latest permissible finish at project completion, respecting successor starts.
  const finish = [...computed.values()].reduce((v, a) => (a.end > v ? a.end : v), '');
  const latest = new Map<string, string>();
  const back = (date: string, n: number) => {
    let d = date;
    for (let guard = 0; guard < 20000; guard++) {
      if (working(d)) {
        if (n === 0) return d;
        n--;
      }
      d = day(d, -1);
    }
    throw new Error('Takvim hesaplama sınırı aşıldı.');
  };
  const rows = [...ordered].reverse().map((a) => {
    const v = computed.get(a.id)!;
    const successors = activities.filter((x) => x.dependencies.includes(a.id));
    const latestEnd = successors.reduce((end, s) => {
      const possible = back(day(latest.get(s.id)!, v.duration === 0 ? 0 : -1), 0);
      return possible < end ? possible : end;
    }, finish);
    const latestStart = back(latestEnd, Math.max(0, v.duration - 1));
    latest.set(a.id, latestStart);
    let slack = 0;
    for (let d = v.start; d < latestStart; d = day(d, 1)) if (working(d)) slack++;
    return {
      ...a,
      computedStart: v.start,
      computedEnd: v.end,
      duration: v.duration,
      slack,
      critical: slack === 0,
    };
  });
  return { finish, activities: rows.reverse() };
}

// --- F9: iş cephesi hazırlığı ve ekip dengeleme ---------------------------------

export type ReadinessConstraint = 'drawing' | 'material' | 'crew' | 'approval';

/** Hazırlık kaydının eksik kısıtları; kayıt yoksa durum bilinmez (öneri 84). */
export function readinessStatus(payload: Record<string, unknown> | null | undefined): { status: 'ready' | 'blocked' | 'unknown'; missing: ReadinessConstraint[] } {
  if (!payload) return { status: 'unknown', missing: [] };
  const missing: ReadinessConstraint[] = [];
  if (!payload.drawingReady) missing.push('drawing');
  if (!payload.materialReady) missing.push('material');
  if (!payload.crewReady) missing.push('crew');
  if (!payload.approvalReady) missing.push('approval');
  return { status: missing.length ? 'blocked' : 'ready', missing };
}

export interface LevelingActivity {
  id: string;
  title: string;
  computedStart: string;
  computedEnd: string;
  slack: number;
  crew?: string;
  crewSize?: number;
  progress: number;
}

/**
 * Ekip dengeleme önerisi (öneri 87): her çalışma gününde ekip ihtiyacı kapasiteyi aşarsa, aşımdaki işlerden en çok bolluğu olan
 * bolluğu kadar ileri kaydırılır (kritik işler kaydırılmaz). Öneridir; programı değiştirmez. Bağımlılıklar bolluk içinde korunur.
 */
export function levelCrews(
  activities: readonly LevelingActivity[],
  crews: readonly { name: string; size: number }[],
  weekdays: number[] = [1, 2, 3, 4, 5],
  holidays: string[] = [],
) {
  const holiday = new Set(holidays);
  const working = (date: string) => weekdays.includes(new Date(date + 'T12:00:00Z').getUTCDay()) && !holiday.has(date);
  const next = (date: string, n = 1) => {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const shiftWorking = (date: string, n: number) => {
    let d = date;
    for (let guard = 0; n > 0 && guard < 20000; guard++) {
      d = next(d);
      if (working(d)) n--;
    }
    return d;
  };
  const capacity = new Map(crews.map((c) => [c.name, c.size]));
  const work = activities
    .filter((a) => a.crew && a.crewSize && a.progress < 100 && capacity.has(a.crew))
    .map((a) => ({ ...a, start: a.computedStart, end: a.computedEnd, shift: 0 }));
  const load = (crew: string) => {
    const days = new Map<string, number>();
    for (const a of work.filter((w) => w.crew === crew))
      for (let d = a.start, g = 0; d <= a.end && g < 20000; d = next(d), g++) if (working(d)) days.set(d, (days.get(d) ?? 0) + (a.crewSize ?? 0));
    return days;
  };
  const overloadsOf = (crew: string) => [...load(crew).entries()].filter(([, n]) => n > (capacity.get(crew) ?? 0)).sort(([a], [b]) => a.localeCompare(b));
  const before = crews.map((c) => ({ crew: c.name, capacity: c.size, overloadDays: overloadsOf(c.name).map(([day, demand]) => ({ day, demand })) }));
  for (const c of crews) {
    for (let guard = 0; guard < 500; guard++) {
      const first = overloadsOf(c.name)[0];
      if (!first) break;
      const [day] = first;
      const candidates = work
        .filter((a) => a.crew === c.name && a.start <= day && a.end >= day && a.slack - a.shift > 0)
        .sort((a, b) => b.slack - b.shift - (a.slack - a.shift) || b.start.localeCompare(a.start));
      const pick = candidates[0];
      if (!pick) break;
      // Aşım gününden sonraya taşı: gereken kaydırma bolluğu aşmaz
      let need = 0;
      for (let d = pick.start; d <= day; d = next(d)) if (working(d)) need++;
      const step = Math.min(need, pick.slack - pick.shift);
      pick.start = shiftWorking(pick.start, step);
      pick.end = shiftWorking(pick.end, step);
      pick.shift += step;
    }
  }
  const after = crews.map((c) => ({ crew: c.name, capacity: c.size, overloadDays: overloadsOf(c.name).map(([day, demand]) => ({ day, demand })) }));
  return {
    before,
    after,
    shifts: work.filter((a) => a.shift > 0).map((a) => ({ id: a.id, title: a.title, crew: a.crew!, shiftDays: a.shift, from: a.computedStart, to: a.start, slack: a.slack })),
  };
}
