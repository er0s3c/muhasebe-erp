import { eq, sql } from 'drizzle-orm';
import {
  dec,
  guaranteeExpiryState,
  todayIso,
  toDbAmount,
  type BankGuaranteeListQuery,
  type BankGuaranteeStatus,
  type CreateBankGuaranteeInput,
  type GuaranteeExpiryState,
  type UpdatePortfolioSettingsInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { bankGuarantees, currencies, parties, portfolioSettings, projects, subcontracts } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { trContains } from '../../db/search';
import { slicePage, type PageQuery } from '../../http/paging';

/**
 * Banka teminat mektubu portföyü (Faz X1): NAZIM takip. Yevmiye yazmaz (nazım hesap/komisyon gideri kaydı yok: belgelenmiş sınır);
 * komisyon oranı/tutarı kullanıcı girişidir ve hiçbir yerde hesaplanmaz. Uyarı günü kullanıcı ayarıdır (boşsa uyarı üretilmez).
 */
export interface GuaranteeCtx {
  companyId: string;
  userId: string;
}

export async function getSettings(tx: Tx) {
  const [row] = await tx.select().from(portfolioSettings);
  return { guaranteeWarningDays: row?.guaranteeWarningDays ?? null };
}

export async function updateSettings(tx: Tx, ctx: GuaranteeCtx, input: UpdatePortfolioSettingsInput) {
  await tx
    .insert(portfolioSettings)
    .values({ companyId: ctx.companyId, guaranteeWarningDays: input.guaranteeWarningDays, updatedBy: ctx.userId })
    .onConflictDoUpdate({ target: portfolioSettings.companyId, set: { guaranteeWarningDays: input.guaranteeWarningDays, updatedBy: ctx.userId, updatedAt: new Date() } });
  return getSettings(tx);
}

const COLS = sql`g.id, g.direction, g.letter_no as "letterNo", g.bank_name as "bankName", g.branch, g.party_id as "partyId", g.counterparty_name as "counterpartyName",
  g.project_id as "projectId", pr.code as "projectCode", pr.name as "projectName", g.subcontract_id as "subcontractId", sc.code as "subcontractCode",
  g.purpose, g.amount::text as amount, g.currency_code as "currencyCode", g.issue_date::text as "issueDate", g.expiry_date::text as "expiryDate",
  g.commission_rate::text as "commissionRate", g.commission_amount::text as "commissionAmount", g.commission_note as "commissionNote", g.note,
  g.status, g.resolved_date::text as "resolvedDate", g.resolution_note as "resolutionNote"`;
const FROM = sql`from bank_guarantees g
  left join projects pr on pr.id = g.project_id and pr.company_id = g.company_id
  left join subcontracts sc on sc.id = g.subcontract_id and sc.company_id = g.company_id`;

export type GuaranteeView = {
  id: string;
  direction: 'given' | 'received';
  letterNo: string;
  bankName: string;
  branch: string | null;
  partyId: string | null;
  counterpartyName: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  subcontractId: string | null;
  subcontractCode: string | null;
  purpose: string | null;
  amount: string;
  currencyCode: string;
  issueDate: string;
  expiryDate: string | null;
  commissionRate: string | null;
  commissionAmount: string | null;
  commissionNote: string | null;
  note: string | null;
  status: BankGuaranteeStatus;
  resolvedDate: string | null;
  resolutionNote: string | null;
};
export type GuaranteeRowOut = GuaranteeView & { expiryState: GuaranteeExpiryState | 'closed'; daysToExpiry: number | null };

function withState(rows: GuaranteeView[], today: string, warningDays: number | null): GuaranteeRowOut[] {
  return rows.map((r) => {
    if (r.status !== 'active') return { ...r, expiryState: 'closed', daysToExpiry: null };
    const s = guaranteeExpiryState(r.expiryDate, today, warningDays);
    return { ...r, expiryState: s.state, daysToExpiry: s.daysToExpiry };
  });
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function listGuarantees(tx: Tx, q: Omit<BankGuaranteeListQuery, 'limit' | 'offset'>, page?: PageQuery) {
  const today = todayIso();
  const settings = await getSettings(tx);
  const res = await tx.execute<GuaranteeView>(sql`
    select ${COLS} ${FROM}
     where true
       ${q.direction ? sql`and g.direction = ${q.direction}` : sql``}
       ${q.status ? sql`and g.status = ${q.status}` : sql``}
       ${q.projectId ? sql`and g.project_id = ${q.projectId}` : sql``}
       ${q.partyId ? sql`and g.party_id = ${q.partyId}` : sql``}
       ${q.withinDays !== undefined ? sql`and g.status = 'active' and g.expiry_date is not null and g.expiry_date <= ${addDays(today, q.withinDays)}::date` : sql``}
       ${q.q ? sql`and ${trContains(['g.letter_no', 'g.bank_name', 'g.counterparty_name'], q.q)}` : sql``}
     order by g.expiry_date nulls last, g.letter_no`);
  const rows = withState(res.rows, today, settings.guaranteeWarningDays);
  const totals = await tx.execute<{ direction: string; currency: string; count: number; amount: string }>(sql`
    select g.direction, g.currency_code as currency, count(*)::int as count, sum(g.amount)::numeric(19,2)::text as amount
      from bank_guarantees g where g.status = 'active' group by g.direction, g.currency_code order by g.direction, g.currency_code`);
  const expiring = rows.filter((r) => r.expiryState === 'expiring').length;
  const lapsed = rows.filter((r) => r.expiryState === 'lapsed').length;
  const pg = slicePage(rows, page);
  return { guarantees: pg.rows, truncated: pg.truncated, asOf: today, warningDays: settings.guaranteeWarningDays, activeTotals: totals.rows, expiring, lapsed };
}

export async function getGuarantee(tx: Tx, id: string): Promise<GuaranteeRowOut> {
  const res = await tx.execute<GuaranteeView>(sql`select ${COLS} ${FROM} where g.id = ${id}`);
  if (res.rows.length === 0) throw notFound('Teminat mektubu');
  return withState(res.rows, todayIso(), (await getSettings(tx)).guaranteeWarningDays)[0]!;
}

export async function createGuarantee(tx: Tx, ctx: GuaranteeCtx, input: CreateBankGuaranteeInput) {
  const [cur] = await tx.select({ code: currencies.code }).from(currencies).where(eq(currencies.code, input.currencyCode));
  if (!cur) throw unprocessable('Para birimi tanımlı değil', 'CURRENCY_NOT_FOUND');
  let counterparty = input.counterpartyName?.trim() ?? '';
  if (input.partyId) {
    const [p] = await tx.select({ name: parties.name, isActive: parties.isActive }).from(parties).where(eq(parties.id, input.partyId));
    if (!p) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
    counterparty = counterparty || p.name;
  }
  let projectId = input.projectId ?? null;
  if (projectId) {
    const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!p) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  }
  if (input.subcontractId) {
    const [s] = await tx.select({ projectId: subcontracts.projectId, partyId: subcontracts.partyId }).from(subcontracts).where(eq(subcontracts.id, input.subcontractId));
    if (!s) throw unprocessable('Sözleşme bulunamadı', 'SUBCONTRACT_NOT_FOUND');
    if (projectId && s.projectId !== projectId) throw unprocessable('Sözleşme seçilen projeye ait değil', 'GUARANTEE_PROJECT_MISMATCH');
    projectId = projectId ?? s.projectId;
  }
  const [dup] = await tx.execute<{ id: string }>(sql`select id from bank_guarantees where direction = ${input.direction} and bank_name = ${input.bankName.trim()} and letter_no = ${input.letterNo.trim()}`).then((r) => r.rows);
  if (dup) throw conflict(`${input.bankName.trim()} bankasının ${input.letterNo.trim()} numaralı mektubu zaten kayıtlı`, 'GUARANTEE_DUPLICATE');
  const [row] = await tx
    .insert(bankGuarantees)
    .values({
      companyId: ctx.companyId,
      direction: input.direction,
      letterNo: input.letterNo.trim(),
      bankName: input.bankName.trim(),
      branch: input.branch?.trim() || null,
      partyId: input.partyId ?? null,
      counterpartyName: counterparty,
      projectId,
      subcontractId: input.subcontractId ?? null,
      purpose: input.purpose?.trim() || null,
      amount: toDbAmount(dec(input.amount)),
      currencyCode: input.currencyCode,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate ?? null,
      commissionRate: input.commissionRate ?? null,
      commissionAmount: input.commissionAmount ? toDbAmount(dec(input.commissionAmount)) : null,
      commissionNote: input.commissionNote?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning({ id: bankGuarantees.id });
  return getGuarantee(tx, row!.id);
}

export async function updateGuarantee(
  tx: Tx,
  id: string,
  input: { branch?: string | null; purpose?: string | null; expiryDate?: string | null; commissionRate?: string | null; commissionAmount?: string | null; commissionNote?: string | null; note?: string | null },
) {
  const [cur] = await tx.select().from(bankGuarantees).where(eq(bankGuarantees.id, id)).for('update');
  if (!cur) throw notFound('Teminat mektubu');
  if (cur.status !== 'active') throw unprocessable('Sonuçlanmış mektup değiştirilemez', 'GUARANTEE_ALREADY_RESOLVED');
  const set: Partial<typeof bankGuarantees.$inferInsert> = { updatedAt: new Date() };
  if (input.branch !== undefined) set.branch = input.branch?.trim() || null;
  if (input.purpose !== undefined) set.purpose = input.purpose?.trim() || null;
  if (input.expiryDate !== undefined) {
    if (input.expiryDate && input.expiryDate < cur.issueDate) throw unprocessable('Son kullanma tarihi düzenleme tarihinden önce olamaz', 'GUARANTEE_DATES');
    set.expiryDate = input.expiryDate;
  }
  if (input.commissionRate !== undefined) set.commissionRate = input.commissionRate;
  if (input.commissionAmount !== undefined) set.commissionAmount = input.commissionAmount ? toDbAmount(dec(input.commissionAmount)) : null;
  if (input.commissionNote !== undefined) set.commissionNote = input.commissionNote?.trim() || null;
  if (input.note !== undefined) set.note = input.note?.trim() || null;
  await tx.update(bankGuarantees).set(set).where(eq(bankGuarantees.id, id));
  return getGuarantee(tx, id);
}

export async function resolveGuarantee(tx: Tx, id: string, input: { status: 'returned' | 'liquidated' | 'expired'; resolvedDate: string; note?: string | null }) {
  const [cur] = await tx.select().from(bankGuarantees).where(eq(bankGuarantees.id, id)).for('update');
  if (!cur) throw notFound('Teminat mektubu');
  if (cur.status !== 'active') throw unprocessable('Mektup zaten sonuçlanmış', 'GUARANTEE_ALREADY_RESOLVED');
  if (input.resolvedDate < cur.issueDate) throw unprocessable('Sonuç tarihi düzenleme tarihinden önce olamaz', 'GUARANTEE_DATES');
  if (input.status === 'expired') {
    if (!cur.expiryDate) throw unprocessable('Süresiz mektup "süresi doldu" olarak kapatılamaz', 'GUARANTEE_NO_EXPIRY');
    if (input.resolvedDate < cur.expiryDate) throw unprocessable('Süresi dolmamış mektup "süresi doldu" olarak kapatılamaz', 'GUARANTEE_NOT_EXPIRED');
  }
  await tx
    .update(bankGuarantees)
    .set({ status: input.status, resolvedDate: input.resolvedDate, resolutionNote: input.note?.trim() || null, updatedAt: new Date() })
    .where(eq(bankGuarantees.id, id));
  return getGuarantee(tx, id);
}

export async function deleteGuarantee(tx: Tx, id: string) {
  const [cur] = await tx.select({ status: bankGuarantees.status }).from(bankGuarantees).where(eq(bankGuarantees.id, id));
  if (!cur) throw notFound('Teminat mektubu');
  if (cur.status !== 'active') throw unprocessable('Sonuçlanmış mektup silinemez', 'GUARANTEE_ALREADY_RESOLVED');
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(bankGuarantees).where(eq(bankGuarantees.id, id)).returning({ id: bankGuarantees.id });
  if (deleted.length === 0) throw notFound('Teminat mektubu');
}

/**
 * Süre uyarı listesi: aktif mektuplar, süre durumuna göre (süresi geçmiş-kapatılmamış önce, sonra dolmak üzere). Uyarı günü ayarsızsa yalnızca
 * "süresi geçmiş" üretilir (uyarı yok). Para birimleri ayrı toplanır (kur çevrimi yok).
 */
export async function guaranteeWarnings(tx: Tx) {
  const { guarantees, warningDays, asOf } = await listGuarantees(tx, { status: 'active' });
  const rows = guarantees
    .filter((g) => g.expiryState === 'expiring' || g.expiryState === 'lapsed')
    .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0));
  return { asOf, warningDays, configured: warningDays !== null, rows };
}

/** Aktif mektup raporu: banka ve projeye göre, yön ve para birimi ayrı (kur çevrimi yok); komisyon tutarı girilmişse toplanır (yalnızca kullanıcı verisi). */
export async function guaranteeReport(tx: Tx) {
  const byBank = await tx.execute<Record<string, unknown>>(sql`
    select g.direction, g.bank_name as "bankName", g.currency_code as currency, count(*)::int as count, sum(g.amount)::numeric(19,2)::text as amount,
           coalesce(sum(g.commission_amount), 0)::numeric(19,2)::text as commission
      from bank_guarantees g where g.status = 'active' group by g.direction, g.bank_name, g.currency_code order by g.direction, g.bank_name, g.currency_code`);
  const byProject = await tx.execute<Record<string, unknown>>(sql`
    select g.direction, g.project_id as "projectId", pr.code as "projectCode", pr.name as "projectName", g.currency_code as currency, count(*)::int as count,
           sum(g.amount)::numeric(19,2)::text as amount
      from bank_guarantees g left join projects pr on pr.id = g.project_id and pr.company_id = g.company_id
     where g.status = 'active' group by g.direction, g.project_id, pr.code, pr.name, g.currency_code order by g.direction, pr.code nulls last, g.currency_code`);
  const closed = await tx.execute<Record<string, unknown>>(sql`
    select g.direction, g.status, g.currency_code as currency, count(*)::int as count, sum(g.amount)::numeric(19,2)::text as amount
      from bank_guarantees g where g.status <> 'active' group by g.direction, g.status, g.currency_code order by g.direction, g.status, g.currency_code`);
  return { byBank: byBank.rows, byProject: byProject.rows, closed: closed.rows };
}
