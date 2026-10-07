import { hash } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import {
  MANUFACTURING_ACCESS_PROFILES,
  ACCESS_AREA_KEYS,
  createItemSchema,
  createStockDocumentSchema,
  leatherRevisionSchema,
  leatherVariantSchema,
  leatherProductionSchema,
  leatherDatedActionSchema,
  leatherIssueSchema,
  leatherQualitySchema,
  leatherQualityDecisionSchema,
  leatherCompletionSchema,
  createPartySchema,
  createSalesDocSchema,
  createInvoiceSchema,
  createTreasuryAccountSchema,
  createTreasuryTransactionSchema,
  todayIso,
  type AccessLevel,
} from '@erp/shared';
import { users, memberships, memberModuleAccess, warehouses, posTills } from './schema';
import { setContext, type Db, type Tx } from './client';
import { createCompany } from '../modules/tenancy/service';
import { createItem } from '../modules/inventory/items';
import { postStockDocument } from '../modules/inventory/documents';
import {
  createModel,
  createRevision,
  approveRevision,
  createVariant,
} from '../modules/leather/catalog';
import {
  createProduction,
  releaseProduction,
  issueProduction,
  recordOperation,
  completeProduction,
} from '../modules/leather/production';
import { createQuality, decideQuality } from '../modules/leather/workflows';
import {
  createRecord,
  schedule,
  maintenance,
  transferAction,
} from '../modules/manufacturing/service';
import { createSubcontract, subcontractAction } from '../modules/leather/advanced';
import { createWarehouse } from '../modules/inventory/warehouses';
import { orderToDelivery } from '../modules/sales/convert';
import { postDeliveryNote } from '../modules/deliveries/posting';
import { newId, one, all, type LeatherCtx } from '../modules/leather/common';
import { createParty } from '../modules/parties/service';
import { createSalesDoc, transitionSalesDoc } from '../modules/sales/orders';
import { createInvoiceDraft } from '../modules/invoices/service';
import { postInvoice } from '../modules/invoices/posting';
import { createTreasuryAccount } from '../modules/treasury/accounts';
import { postTreasuryTransaction } from '../modules/treasury/posting';

export const MANUFACTURING_DEMO_NAME = 'Ada Üretim ve Toptan Ticaret Demo';
export const MANUFACTURING_DEMO_DATASET = 'manufacturing-demo-v1';
export async function seedManufacturingDemo(
  db: Db,
  log: (s: string) => void = console.log,
): Promise<boolean> {
  const [owner] = await db.select().from(users).where(eq(users.email, 'demo@ornek.local'));
  if (!owner) throw new Error('Önce mevcut demo hesabı kurulmalı: npm run db:seed');
  return db.transaction(async (tx) => {
    await setContext(tx, { userId: owner.id, orgId: owner.organizationId });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'manufacturing-demo:' + owner.organizationId},0))`,
    );
    // A marker, not a company name, identifies the dataset. Never adopt unrelated customer data.
    const existing = await all(
      tx,
      sql`select c.id from companies c where c.organization_id=${owner.organizationId} and c.id in (select company_id from memberships where user_id=${owner.id}) and c.tax_number='DEMO-MFG-V1'`,
    );
    if (existing.length) {
      await setContext(tx, {
        userId: owner.id,
        orgId: owner.organizationId,
        companyId: existing[0]!.id,
      });
      const marker = await all(
        tx,
        sql`select id from manufacturing_records where kind='demo_dataset' and code=${MANUFACTURING_DEMO_DATASET}`,
      );
      if (marker.length)
        return upgradeDemo(tx, {
          companyId: existing[0]!.id,
          userId: owner.id,
          baseCurrency: 'TRY',
          reportingCurrency: null,
          allowNegativeStock: false,
        });
      throw new Error(
        'Üretim demo kimliği var ancak veri sürümü bulunamadı; mevcut veri korunuyor.',
      );
    }
    const company = await createCompany(tx, { id: owner.id, orgId: owner.organizationId }, {
      name: MANUFACTURING_DEMO_NAME,
      sector: 'MANUFACTURING_WHOLESALE',
      baseCurrency: 'TRY',
      reportingCurrency: null,
      taxNumber: 'DEMO-MFG-V1',
    } as never);
    const ctx: LeatherCtx = {
      companyId: company.id,
      userId: owner.id,
      baseCurrency: 'TRY',
      reportingCurrency: null,
      allowNegativeStock: false,
    };
    const passwordHash = await hash('Demo-Sifre-123');
    const userIds = new Map<string, string>();
    for (const profile of MANUFACTURING_ACCESS_PROFILES) {
      const email = 'uretim.' + profile.key + '@ornek.local';
      const [prior] = await tx.select().from(users).where(eq(users.email, email));
      if (prior && prior.organizationId !== owner.organizationId)
        throw new Error(email + ' başka kuruluşa ait; demo kurulumuna eklenemez.');
      const u =
        prior ??
        (
          await tx
            .insert(users)
            .values({
              organizationId: owner.organizationId,
              email,
              passwordHash,
              fullName: profile.label,
              emailVerifiedAt: new Date(),
            })
            .returning()
        )[0]!;
      userIds.set(profile.key, u.id);
      await tx
        .insert(memberships)
        .values({ companyId: company.id, userId: u.id, role: profile.role });
      await tx
        .insert(memberModuleAccess)
        .values(
          ACCESS_AREA_KEYS.map((area) => ({
            companyId: company.id,
            userId: u.id,
            moduleKey: area,
            level: (profile.levels[area] ?? 'none') as AccessLevel,
            setBy: owner.id,
            note: 'Üretim demo görev profili',
          })),
        );
    }
    const warehouse = (
      await tx.select().from(warehouses).where(eq(warehouses.companyId, company.id))
    )[0]!;
    await populate(tx, ctx, warehouse.id, userIds);
    await createRecord(
      tx,
      ctx,
      'demo_dataset',
      { code: MANUFACTURING_DEMO_DATASET, version: 1 },
      'completed',
    );
    await upgradeDemo(tx, ctx);
    log('Üretim demo şirketi eklendi: ' + MANUFACTURING_DEMO_NAME);
    log('9 görev kullanıcısı: uretim.<profil>@ornek.local / Demo-Sifre-123');
    return true;
  });
}
async function populate(
  tx: Tx,
  ctx: LeatherCtx,
  warehouseId: string,
  userIds: Map<string, string>,
) {
  const date = todayIso();
  const action = (extra: Record<string, unknown> = {}) =>
    leatherDatedActionSchema.parse({ date, requestKey: newId(), ...extra });
  const raw = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-001',
      name: 'Üretim hammaddesi',
      unit: 'adet',
      inventoryRole: 'raw_material',
    }),
  );
  const semi = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'YAR-001',
      name: 'Montaj yarı mamulü',
      unit: 'adet',
      inventoryRole: 'semi_finished',
    }),
  );
  const fg = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-001',
      name: 'Standart toptan ürün',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: 'DEMO-MFG-001',
      salePrice: '250',
    }),
  );
  const opening = await postStockDocument(
    tx,
    ctx,
    createStockDocumentSchema.parse({
      type: 'opening',
      docDate: date,
      warehouseId,
      description: 'Üretim demo açılışı',
      lines: [
        { itemId: raw.id, quantity: '2000', unitCost: '10' },
        { itemId: semi.id, quantity: '500', unitCost: '20' },
        { itemId: fg.id, quantity: '120', unitCost: '60' },
      ],
    }),
  );
  async function recipe(code: string, itemId: string, materialId: string, quantity: string) {
    const m = await createModel(tx, ctx, {
      code,
      name: code === 'REC-MAM' ? 'Toptan ürün ailesi' : 'Yarı mamul ailesi',
      family: 'Genel üretim',
      description: 'Demo',
    });
    const r = await createRevision(
      tx,
      ctx,
      m.id,
      leatherRevisionSchema.parse({
        name: 'Onaylı revizyon 1',
        sampleApproved: true,
        materials: [{ itemId: materialId, quantity }],
        operations: [
          { key: 'assembly', name: 'Montaj', station: 'Montaj istasyonu', plannedMinutes: '3' },
          {
            key: 'packing',
            name: 'Paketleme',
            station: 'Paketleme istasyonu',
            plannedMinutes: '1',
          },
        ],
      }),
    );
    await approveRevision(tx, ctx, r.id);
    return createVariant(
      tx,
      ctx,
      leatherVariantSchema.parse({ modelId: m.id, revisionId: r.id, itemId, color: 'Standart' }),
    );
  }
  await recipe('REC-YAR', semi.id, raw.id, '2');
  const variant = await recipe('REC-MAM', fg.id, semi.id, '1');
  const customer = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({ name: 'Demo Toptan Bayi', kind: 'customer' }),
  );
  const supplier = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({ name: 'Demo Fason Atölye', kind: 'supplier' }),
  );
  const salesCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' };
  const sale = await createSalesDoc(
    tx,
    salesCtx,
    createSalesDocSchema.parse({
      kind: 'order',
      partyId: customer.id,
      warehouseId,
      docDate: date,
      currency: 'TRY',
      lines: [{ itemId: fg.id, description: fg.name, quantity: '500', unitPrice: '250' }],
    }),
  );
  await transitionSalesDoc(tx, salesCtx, sale, 'confirmed');
  const order = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: variant.id,
      revisionId: variant.revisionId,
      warehouseId,
      outputWarehouseId: warehouseId,
      quantity: '380',
      assignedUserId: userIds.get('atolye'),
      dueDate: date,
      note: '500 talep − 120 stok = 380 üretim',
    }),
  );
  await releaseProduction(tx, ctx, order.id, action());
  await issueProduction(
    tx,
    ctx,
    order.id,
    leatherIssueSchema.parse({ ...action(), lines: [{ itemId: semi.id, quantity: '380' }] }),
  );
  await recordOperation(tx, ctx, order.id, {
    ...action(),
    key: 'assembly',
    status: 'started',
    quantity: '100',
    goodQty: '100',
    minutes: '300',
    reworkQty: '0',
    scrapQty: '0',
  });
  const check = await createQuality(
    tx,
    ctx,
    leatherQualitySchema.parse({
      scope: 'production',
      sourceId: order.id,
      stage: 'final',
      inspectedQty: '100',
      passedQty: '100',
      checks: [{ label: 'Ölçü ve montaj kontrolü', passed: true }],
    }),
  );
  await decideQuality(
    tx,
    ctx,
    check.id,
    leatherQualityDecisionSchema.parse({ decision: 'approve' }),
  );
  await completeProduction(
    tx,
    ctx,
    order.id,
    leatherCompletionSchema.parse({ ...action(), quantity: '100', qualityCheckId: check.id }),
  );
  const machine = await createRecord(
    tx,
    ctx,
    'resource',
    { code: 'MAK-01', name: 'Montaj makinesi', type: 'machine', capacity: 1 },
    'active',
  );
  const anchor = new Date(date + 'T08:00:00Z');
  const start = anchor.toISOString(),
    end = new Date(anchor.getTime() + 7 * 86400000).toISOString();
  for (let day = 0; day < 7; day++)
    await createRecord(
      tx,
      ctx,
      'calendar',
      {
        resourceId: machine.id,
        start: new Date(anchor.getTime() + day * 86400000).toISOString(),
        end: new Date(anchor.getTime() + day * 86400000 + 9 * 3600000).toISOString(),
        available: true,
        reason: 'shift',
      },
      'active',
    );
  const jobs = [
    {
      orderId: order.id,
      operationKey: 'assembly',
      resourceId: machine.id,
      minutes: 840,
      priority: 80,
    },
  ];
  const scenario = { jobs, anchor: start, direction: 'forward' as const };
  await createRecord(tx, ctx, 'schedule', {
    ...scenario,
    operations: await schedule(tx, scenario),
  });
  await maintenance(tx, ctx, {
    resourceId: machine.id,
    start: new Date(anchor.getTime() + 2 * 86400000).toISOString(),
    end: new Date(anchor.getTime() + 2 * 86400000 + 3600000).toISOString(),
    kind: 'planned',
    description: 'Haftalık bakım',
    spareParts: [],
  });
  const bin = await createRecord(
    tx,
    ctx,
    'bin',
    { code: 'A-01', name: 'Hammadde rafı', warehouseId, capacity: '3000' },
    'active',
  );
  const lot = await createRecord(
    tx,
    ctx,
    'lot',
    {
      code: 'LOT-DEMO-01',
      itemId: raw.id,
      warehouseId,
      sourceDocumentId: opening.document.id,
      quantity: '20',
      serials: [],
    },
    'quarantine',
  );
  await createRecord(
    tx,
    ctx,
    'placement',
    { lotId: lot.id, binId: bin.id, quantity: '20', itemId: raw.id, warehouseId },
    'placed',
  );
  const invoice = await createInvoiceDraft(
    tx,
    ctx,
    createInvoiceSchema.parse({
      type: 'sales',
      partyId: customer.id,
      warehouseId,
      invoiceDate: date,
      lines: [{ itemId: fg.id, description: fg.name, quantity: '5', unitPrice: '250' }],
    }),
  );
  await postInvoice(tx, ctx, invoice);
  const cash = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'Üretim demo mağaza kasası',
      kind: 'cash',
      currency: 'TRY',
    }),
  );
  await postTreasuryTransaction(
    tx,
    ctx,
    createTreasuryTransactionSchema.parse({
      type: 'receipt',
      accountId: cash.id,
      partyId: customer.id,
      date,
      amount: '1250',
      description: 'Demo satış tahsilatı',
    }),
  );
  await tx
    .insert(posTills)
    .values({
      companyId: ctx.companyId,
      name: 'Demo mağaza POS',
      warehouseId,
      cashAccountId: cash.id,
      assignedUserIds: [userIds.get('kasiyer')!],
      id: newId(),
      walkInPartyId: customer.id,
      currencyCode: 'TRY',
      createdBy: ctx.userId,
    });
  await createRecord(
    tx,
    ctx,
    'connection',
    { provider: 'shopify', name: 'Shopify — bağlantı bekliyor' },
    'disconnected',
  );
  await createRecord(
    tx,
    ctx,
    'connection',
    { provider: 'ticimax', name: 'Ticimax — bağlantı bekliyor' },
    'disconnected',
  );
  void supplier;
  void end;
}

/** Each added scenario has its own marker and runs in the company installation transaction. */
async function upgradeDemo(tx: Tx, ctx: LeatherCtx): Promise<boolean> {
  const code = 'manufacturing-demo-v2';
  if (
    (
      await all(
        tx,
        sql`select id from manufacturing_records where kind='demo_dataset' and code=${code}`,
      )
    ).length
  )
    return linkDemoOrder(tx, ctx);
  const date = todayIso(),
    action = (extra: Record<string, unknown> = {}) => ({
      date,
      requestKey: newId(),
      note: 'Demo senaryosu',
      ...extra,
    });
  const warehouse = await one(tx, sql`select id from warehouses order by created_at limit 1`);
  const raw = await one(tx, sql`select id from items where code='HAM-001'`),
    fg = await one(tx, sql`select id from items where code='MAM-001'`);
  const order = await one(
    tx,
    sql`select id from leather_production_orders where item_id=${fg.id} order by created_at limit 1`,
  );
  const transfer = await createRecord(tx, ctx, 'transfer', {
    orderId: order.id,
    fromOperation: 'assembly',
    toOperation: 'packing',
    quantity: '100',
    receivedQty: '0',
    assignedUserId: (
      await one(tx, sql`select config from leather_production_orders where id=${order.id}`)
    ).config.assignedUserId,
    note: 'Operasyonlar arası kısmi kabul',
  });
  for (const [kind, quantity] of [
    ['approve', undefined],
    ['dispatch', undefined],
    ['receive', '60'],
  ] as const)
    await transferAction(tx, ctx, transfer.id, { action: kind, quantity, requestKey: newId() });
  const salesOrder = await one(
    tx,
    sql`select l.id,l.order_id,o.party_id from sales_order_lines l join sales_orders o on o.id=l.order_id where l.item_id=${fg.id} and o.status='confirmed' order by o.created_at limit 1`,
  );
  const noteId = await orderToDelivery(tx, ctx, salesOrder.order_id, {
    noteDate: date,
    warehouseId: warehouse.id,
    lines: [{ lineId: salesOrder.id, quantity: '20' }],
  });
  await postDeliveryNote(tx, ctx, noteId);
  await createRecord(
    tx,
    ctx,
    'shipment',
    {
      deliveryNoteId: noteId,
      warehouseId: warehouse.id,
      carrier: 'Demo taşıyıcı',
      trackingNo: 'DEMO-SEVK-01',
      packages: [{ code: 'KOLI-01', type: 'box', lines: [{ itemId: fg.id, quantity: '20' }] }],
    },
    'packed',
  );
  const external = await createWarehouse(tx, ctx.companyId, {
    name: 'Fason atölyedeki şirket stoğu',
    isDefault: false,
  });
  const item = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'YAR-FASON',
      name: 'Fason yarı mamul örneği',
      unit: 'adet',
      inventoryRole: 'semi_finished',
    }),
  );
  const m = await createModel(tx, ctx, {
    code: 'REC-FASON',
    name: 'Dış montaj',
    family: 'Genel üretim',
    description: 'Şirket malzemesi fasona sevk edilir',
  });
  const rev = await createRevision(
    tx,
    ctx,
    m.id,
    leatherRevisionSchema.parse({
      name: 'Fason rota',
      sampleApproved: true,
      materials: [{ itemId: raw.id, quantity: '1' }],
      operations: [{ key: 'external', name: 'Fason montaj', outsourced: true }],
    }),
  );
  await approveRevision(tx, ctx, rev.id);
  const variant = await createVariant(
    tx,
    ctx,
    leatherVariantSchema.parse({
      modelId: m.id,
      revisionId: rev.id,
      itemId: item.id,
      color: 'Standart',
    }),
  );
  const work = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: variant.id,
      revisionId: rev.id,
      warehouseId: warehouse.id,
      outputWarehouseId: warehouse.id,
      quantity: '30',
    }),
  );
  await releaseProduction(tx, ctx, work.id, leatherDatedActionSchema.parse(action()));
  const supplier = await one(tx, sql`select id from parties where name='Demo Fason Atölye'`);
  const job = await createSubcontract(tx, ctx, {
    orderId: work.id,
    partyId: supplier.id,
    operationKey: 'external',
    quantity: '30',
    externalWarehouseId: external.id,
  });
  await subcontractAction(tx, ctx, job.id, {
    ...action(),
    action: 'dispatch',
    materials: [{ itemId: raw.id, quantity: '30', pieces: [] }],
  });
  await subcontractAction(tx, ctx, job.id, {
    ...action(),
    action: 'consume',
    materials: [{ itemId: raw.id, quantity: '10', pieces: [] }],
  });
  await subcontractAction(tx, ctx, job.id, {
    ...action(),
    action: 'return',
    quantity: '10',
    materials: [],
  });
  await createRecord(tx, ctx, 'demo_dataset', { code, version: 2 }, 'completed');
  await linkDemoOrder(tx, ctx);
  return true;
}

async function linkDemoOrder(tx: Tx, ctx: LeatherCtx): Promise<boolean> {
  const code = 'manufacturing-demo-v3';
  if (
    (
      await all(
        tx,
        sql`select id from manufacturing_records where kind='demo_dataset' and code=${code}`,
      )
    ).length
  )
    return false;
  const source = await one(
    tx,
    sql`select l.id,l.order_id from sales_order_lines l join sales_orders o on o.id=l.order_id join items i on i.id=l.item_id where i.code='MAM-001' and o.status='confirmed' order by o.created_at limit 1`,
  );
  await tx.execute(
    sql`update leather_production_orders set config=config||${JSON.stringify({ salesOrderLineId: source.id, salesOrderId: source.order_id })}::jsonb where id=(select p.id from leather_production_orders p join items i on i.id=p.item_id where i.code='MAM-001' order by p.created_at limit 1)`,
  );
  // Upgrade the early demo calendar to real daily shifts without altering stock or ledger entries.
  const calendars = await all(
    tx,
    sql`select * from manufacturing_records where kind='calendar' and config->>'reason'='shift'`,
  );
  for (const calendar of calendars) {
    const start = Date.parse(calendar.config.start),
      end = Date.parse(calendar.config.end);
    if (end - start <= 86400000) continue;
    await tx.execute(
      sql`update manufacturing_records set status='cancelled',updated_at=now() where id=${calendar.id}`,
    );
    for (let day = 0; day < 7; day++)
      await createRecord(
        tx,
        ctx,
        'calendar',
        {
          ...calendar.config,
          code: code + ':' + calendar.id + ':' + day,
          start: new Date(start + day * 86400000).toISOString(),
          end: new Date(start + day * 86400000 + 9 * 3600000).toISOString(),
        },
        'active',
      );
  }
  await createRecord(tx, ctx, 'demo_dataset', { code, version: 3 }, 'completed');
  return true;
}
