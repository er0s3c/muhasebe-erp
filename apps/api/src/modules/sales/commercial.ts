import { asc, eq, inArray, sql } from 'drizzle-orm';
import { dec, roundMoney, todayIso, toDbAmount, toDbRate, type MoneyValue, type SalesCheckMode, type SalesPolicyInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { items, parties, salesDocSnapshots, salesOrderLines, salesOrders, salesPolicies, users } from '../../db/schema';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { loadItemStates } from '../inventory/balances';
import { requireRate } from '../settings/rates';

/**
 * Teklif/sipariş ticari kontrolleri (F6: öneri 33, 34, 35, 38). Teklif gönderiminde ve sipariş onayında satırların birim
 * maliyeti (stok defteri ortalaması, yoksa son alış maliyeti), katkı yüzdesi ve müşterinin kredi riski hesaplanır, değişmez
 * bir görüntü olarak saklanır. Politika `block` ise sınır aşımı onay yetkilisinin gerekçesiyle geçilebilir; `warn` yalnız kaydeder.
 * Maliyet bilinmeyen satır (hizmet, hiç girişi olmayan kart) katkıya 0 maliyetle girer ve açıkça işaretlenir.
 */

export interface SalesPolicy {
  minMarginPct: string | null;
  marginMode: SalesCheckMode;
  creditMode: SalesCheckMode;
}

export async function loadSalesPolicy(tx: Tx): Promise<SalesPolicy> {
  const [row] = await tx.select().from(salesPolicies);
  return row
    ? { minMarginPct: row.minMarginPct === null ? null : dec(row.minMarginPct).toFixed(2), marginMode: row.marginMode, creditMode: row.creditMode }
    : { minMarginPct: null, marginMode: 'warn', creditMode: 'warn' };
}

export async function saveSalesPolicy(tx: Tx, ctx: { companyId: string; userId: string }, input: SalesPolicyInput) {
  const values = { minMarginPct: input.minMarginPct, marginMode: input.marginMode, creditMode: input.creditMode, updatedBy: ctx.userId, updatedAt: new Date() };
  await tx
    .insert(salesPolicies)
    .values({ companyId: ctx.companyId, ...values })
    .onConflictDoUpdate({ target: salesPolicies.companyId, set: values });
  return loadSalesPolicy(tx);
}

/** Kur yoksa null (kontrol tahmin yapmaz; uyarı verir). */
async function rateOrNull(tx: Tx, from: string, base: string, date: string): Promise<MoneyValue | null> {
  if (from === base) return dec(1);
  try {
    return await requireRate(tx, from, base, date, base);
  } catch {
    return null;
  }
}

/** Müşterinin defter para birimindeki riski: alacak bakiyesi + onaylı siparişlerin faturalanmamış kısmı (KDV dahil). */
export async function partyExposure(tx: Tx, baseCurrency: string, partyId: string, exceptOrderId?: string) {
  const bal = await tx.execute<{ balance: string }>(sql`
    select coalesce(sum(l.debit_base - l.credit_base), 0)::text as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where l.party_id = ${partyId} and a.party_control = 'receivable'`);
  const orders = await tx.execute<{ id: string; currency_code: string; doc_date: string; open_gross: string }>(sql`
    select o.id, o.currency_code, o.doc_date::text as doc_date,
           coalesce(sum(l.gross * greatest(0, 1 - coalesce(inv.qty, 0) / l.quantity)), 0)::text as open_gross
      from sales_orders o
      join sales_order_lines l on l.order_id = o.id
      left join (
        select il.sales_order_line_id, sum(il.quantity) as qty
          from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
         where il.sales_order_line_id is not null group by il.sales_order_line_id
      ) inv on inv.sales_order_line_id = l.id
     where o.party_id = ${partyId} and o.kind = 'order' and o.status = 'confirmed'
       ${exceptOrderId ? sql`and o.id <> ${exceptOrderId}` : sql``}
     group by o.id`);
  let openOrders = dec(0);
  let incomplete = false;
  for (const o of orders.rows) {
    const fx = await rateOrNull(tx, o.currency_code, baseCurrency, o.doc_date);
    if (fx === null) incomplete = true;
    else openOrders = openOrders.plus(roundMoney(dec(o.open_gross).times(fx)));
  }
  const balance = dec(bal.rows[0]!.balance);
  return { balance, openOrders, total: balance.plus(openOrders), incomplete };
}

export interface SnapshotLine {
  lineNo: number;
  itemId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  net: string;
  netBase: string;
  unitCostBase: string | null;
  costBase: string;
  costKnown: boolean;
}

/** Belgenin ticari görüntüsünü hesaplar (yazmaz). `asOf` verilirse kur o tarihte, yoksa belge tarihinde alınır. */
export async function computeCommercial(tx: Tx, baseCurrency: string, orderId: string, opts: { asOf?: string } = {}) {
  const [doc] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId));
  if (!doc) throw notFound('Teklif/sipariş');
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId)).orderBy(asc(salesOrderLines.lineNo));
  const rateDate = opts.asOf ?? doc.docDate;
  const fx = await rateOrNull(tx, doc.currencyCode, baseCurrency, rateDate);
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const kinds = new Map(itemIds.length ? (await tx.select({ id: items.id, kind: items.kind }).from(items).where(inArray(items.id, itemIds))).map((r) => [r.id, r.kind]) : []);
  const states = await loadItemStates(tx, itemIds.filter((id) => kinds.get(id) === 'goods'));

  let netBase = dec(0);
  let costBase = dec(0);
  const out: SnapshotLine[] = lines.map((l) => {
    const lineNet = fx === null ? dec(0) : roundMoney(dec(l.net).times(fx));
    const state = l.itemId ? states.get(l.itemId) : undefined;
    let unitCost: MoneyValue | null = null;
    if (state) unitCost = state.qty.gt(0) && state.value.gt(0) ? state.value.div(state.qty) : state.lastCost;
    const cost = unitCost ? roundMoney(unitCost.times(l.quantity)) : dec(0);
    netBase = netBase.plus(lineNet);
    costBase = costBase.plus(cost);
    return {
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      quantity: dec(l.quantity).toFixed(4),
      unitPrice: dec(l.unitPrice).toFixed(6),
      discountPct: dec(l.discountPct).toFixed(4),
      net: dec(l.net).toFixed(4),
      netBase: toDbAmount(lineNet),
      unitCostBase: unitCost ? unitCost.toFixed(6) : null,
      costBase: toDbAmount(cost),
      // Stoklu kartın maliyeti bilinir; hizmet ve kartsız satırın maliyeti bu görüntüde yoktur
      costKnown: unitCost !== null,
    };
  });
  const marginPct = fx !== null && netBase.gt(0) ? roundMoney(netBase.minus(costBase).div(netBase).times(100)).toFixed(2) : null;
  return { doc, fx, grossBase: fx === null ? null : roundMoney(dec(doc.grossTotal).times(fx)), netBase, costBase, marginPct, lines: out };
}

export interface CommercialGate {
  overrideReason?: string;
  canOverride: boolean;
}

/**
 * Teklif gönderimi (`sent`) ya da sipariş onayı (`confirmed`) anında ticari görüntüyü saklar ve politikayı uygular.
 * Engelleyen uyarı varsa gerekçesiz geçiş reddedilir; gerekçe yalnız onay yetkilisinden kabul edilir.
 */
export async function recordCommercialSnapshot(
  tx: Tx,
  ctx: { companyId: string; userId: string; baseCurrency: string },
  orderId: string,
  event: 'sent' | 'confirmed',
  gate: CommercialGate,
) {
  const policy = await loadSalesPolicy(tx);
  const c = await computeCommercial(tx, ctx.baseCurrency, orderId);
  const [party] = await tx.select({ creditLimit: parties.creditLimit, name: parties.name }).from(parties).where(eq(parties.id, c.doc.partyId));
  const warnings: { code: string; mode: SalesCheckMode }[] = [];
  if (c.fx === null) warnings.push({ code: 'FX_RATE_MISSING', mode: 'warn' });
  if (c.lines.some((l) => !l.costKnown && l.itemId)) warnings.push({ code: 'COST_UNKNOWN', mode: 'warn' });
  if (policy.minMarginPct !== null && policy.marginMode !== 'off' && c.marginPct !== null && dec(c.marginPct).lt(policy.minMarginPct)) {
    warnings.push({ code: 'MARGIN_BELOW_MIN', mode: policy.marginMode });
  }
  let exposure: MoneyValue | null = null;
  const limit = party?.creditLimit ?? null;
  if (limit !== null && policy.creditMode !== 'off') {
    const risk = await partyExposure(tx, ctx.baseCurrency, c.doc.partyId, orderId);
    if (risk.incomplete || c.grossBase === null) warnings.push({ code: 'FX_RATE_MISSING', mode: 'warn' });
    exposure = risk.total.plus(c.grossBase ?? 0);
    if (exposure.gt(limit)) warnings.push({ code: 'CREDIT_LIMIT_EXCEEDED', mode: policy.creditMode });
  }
  const blocking = warnings.filter((w) => w.mode === 'block').map((w) => w.code);
  const details = {
    warnings: [...new Set(warnings.map((w) => w.code))],
    blocking,
    marginPct: c.marginPct,
    minMarginPct: policy.minMarginPct,
    creditLimit: limit === null ? null : toDbAmount(limit),
    exposure: exposure === null ? null : toDbAmount(exposure),
  };
  if (blocking.length > 0) {
    if (!gate.overrideReason) {
      const what = blocking.map((b) => (b === 'MARGIN_BELOW_MIN' ? `katkı %${c.marginPct ?? '—'} < asgari %${policy.minMarginPct}` : `kredi riski ${details.exposure} > limit ${details.creditLimit}`));
      throw unprocessable(`Ticari kontrol: ${what.join('; ')}. Onay yetkilisi gerekçeyle geçebilir.`, 'SO_COMMERCIAL_BLOCK', details);
    }
    if (!gate.canOverride) throw forbidden('Ticari kontrolü yalnız onay yetkilisi (fatura kaydetme yetkisi) gerekçeyle geçebilir', 'SO_OVERRIDE_FORBIDDEN');
  }
  const prev = await tx.execute<{ n: number }>(sql`select count(*)::int as n from sales_doc_snapshots where order_id = ${orderId} and event = ${event}`);
  await tx.insert(salesDocSnapshots).values({
    companyId: ctx.companyId,
    orderId,
    event,
    revisionNo: (prev.rows[0]?.n ?? 0) + 1,
    currencyCode: c.doc.currencyCode,
    fxRate: c.fx === null ? null : toDbRate(c.fx),
    netBase: toDbAmount(c.netBase),
    costBase: toDbAmount(c.costBase),
    marginPct: c.marginPct,
    minMarginPct: policy.minMarginPct,
    creditLimit: details.creditLimit,
    exposure: details.exposure,
    warnings: details.warnings,
    overrideReason: blocking.length > 0 ? gate.overrideReason! : null,
    lines: c.lines as unknown as Record<string, unknown>[],
    createdBy: ctx.userId,
  });
  return details;
}

const snapshotOut = (s: typeof salesDocSnapshots.$inferSelect) => ({
  id: s.id,
  event: s.event,
  revisionNo: s.revisionNo,
  currencyCode: s.currencyCode,
  fxRate: s.fxRate,
  netBase: s.netBase,
  costBase: s.costBase,
  marginPct: s.marginPct,
  minMarginPct: s.minMarginPct,
  creditLimit: s.creditLimit,
  exposure: s.exposure,
  warnings: s.warnings,
  overrideReason: s.overrideReason,
  lines: s.lines as unknown as SnapshotLine[],
  createdAt: s.createdAt,
});

/**
 * Teklif geçerliliği ve güncel maliyet farkı (öneri 33): son görüntü ile bugünkü maliyet/kur karşılaştırılır.
 * Taslak belgede görüntü yoksa yalnız bugünkü hesap döner.
 */
export async function commercialView(tx: Tx, baseCurrency: string, orderId: string) {
  const policy = await loadSalesPolicy(tx);
  const current = await computeCommercial(tx, baseCurrency, orderId, { asOf: todayIso() });
  const [last] = await tx.select().from(salesDocSnapshots).where(eq(salesDocSnapshots.orderId, orderId)).orderBy(sql`${salesDocSnapshots.createdAt} desc, ${salesDocSnapshots.revisionNo} desc`).limit(1);
  const snap = last ? snapshotOut(last) : null;
  const today = todayIso();
  const validUntil = current.doc.validUntil;
  const daysLeft = validUntil ? Math.round((Date.parse(validUntil) - Date.parse(today)) / 86_400_000) : null;
  const lines = current.lines.map((l) => {
    const then = snap?.lines.find((s) => s.lineNo === l.lineNo);
    const costDiff = then && then.costKnown && l.costKnown ? dec(l.costBase).minus(then.costBase) : null;
    return { ...l, snapshotUnitCostBase: then?.unitCostBase ?? null, costDiffBase: costDiff === null ? null : toDbAmount(costDiff) };
  });
  return {
    policy,
    validity: { validUntil, daysLeft, expired: daysLeft !== null && daysLeft < 0 },
    snapshot: snap,
    current: {
      fxRate: current.fx === null ? null : toDbRate(current.fx),
      netBase: toDbAmount(current.netBase),
      costBase: toDbAmount(current.costBase),
      marginPct: current.marginPct,
      lines,
    },
    changes: snap
      ? {
          fxRate: snap.currencyCode === baseCurrency ? null : { then: snap.fxRate, now: current.fx === null ? null : toDbRate(current.fx) },
          costBase: toDbAmount(current.costBase.minus(snap.costBase)),
          marginPts: snap.marginPct !== null && current.marginPct !== null ? dec(current.marginPct).minus(snap.marginPct).toFixed(2) : null,
        }
      : null,
  };
}

type Span = { from: string; to: string };
type LineChange =
  | { lineNo: number; description: string; change: 'added' | 'removed' }
  | { lineNo: number; description: string; change: 'changed'; unitPrice: Span; discountPct: Span; quantity: Span; net: Span };

/**
 * Müzakere ve ticari taviz geçmişi (öneri 34): teklifin her gönderimi bir revizyondur. Ardışık revizyonlar arasındaki birim
 * fiyat, iskonto ve net tutar farkı tavizi gösterir; teklifin taslağa geri alınma gerekçeleri araya yerleştirilir.
 */
export async function negotiationHistory(tx: Tx, orderId: string) {
  const [doc] = await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, orderId));
  if (!doc) throw notFound('Teklif/sipariş');
  const rows = await tx
    .select({ s: salesDocSnapshots, userName: users.fullName })
    .from(salesDocSnapshots)
    .leftJoin(users, eq(users.id, salesDocSnapshots.createdBy))
    .where(eq(salesDocSnapshots.orderId, orderId))
    .orderBy(asc(salesDocSnapshots.createdAt), asc(salesDocSnapshots.event), asc(salesDocSnapshots.revisionNo));
  const reopens = (
    await tx.execute<{ reason: string | null; created_at: string; user_name: string | null }>(sql`
      select e.reason, e.created_at::text as created_at, u.full_name as user_name
        from sales_order_events e left join users u on u.id = e.created_by
       where e.order_id = ${orderId} and e.to_status = 'draft' order by e.created_at`)
  ).rows;
  let prev: ReturnType<typeof snapshotOut> | null = null;
  const revisions = rows.map((raw) => {
    const s = snapshotOut(raw.s);
    const docNet = s.lines.reduce((sum, l) => sum.plus(l.net), dec(0));
    const prevNet = prev ? prev.lines.reduce((sum, l) => sum.plus(l.net), dec(0)) : null;
    const lineChanges: LineChange[] = [];
    if (prev) {
      const before = prev.lines;
      for (const l of s.lines) {
        const p = before.find((x) => x.lineNo === l.lineNo && x.itemId === l.itemId);
        if (!p) lineChanges.push({ lineNo: l.lineNo, description: l.description, change: 'added' });
        else if (p.unitPrice !== l.unitPrice || p.discountPct !== l.discountPct || p.quantity !== l.quantity) {
          lineChanges.push({
            lineNo: l.lineNo,
            description: l.description,
            change: 'changed',
            unitPrice: { from: p.unitPrice, to: l.unitPrice },
            discountPct: { from: p.discountPct, to: l.discountPct },
            quantity: { from: p.quantity, to: l.quantity },
            net: { from: p.net, to: l.net },
          });
        }
      }
      for (const p of before) {
        if (!s.lines.some((l) => l.lineNo === p.lineNo && l.itemId === p.itemId)) lineChanges.push({ lineNo: p.lineNo, description: p.description, change: 'removed' });
      }
    }
    const out = {
      ...s,
      userName: raw.userName,
      docNet: toDbAmount(docNet),
      // Taviz: önceki gönderime göre belge para biriminde net düşüş (artış negatif görünür)
      concession: prevNet === null ? null : toDbAmount(prevNet.minus(docNet)),
      marginPts: prev && prev.marginPct !== null && s.marginPct !== null ? dec(s.marginPct).minus(prev.marginPct).toFixed(2) : null,
      lineChanges,
    };
    if (s.event === 'sent') prev = s;
    return out;
  });
  const first = revisions.find((r) => r.event === 'sent');
  const last = [...revisions].reverse().find((r) => r.event === 'sent');
  return {
    revisions,
    reopens: reopens.map((r) => ({ reason: r.reason, at: r.created_at, userName: r.user_name })),
    totalConcession: first && last && first !== last ? toDbAmount(dec(first.docNet).minus(last.docNet)) : '0.0000',
  };
}
