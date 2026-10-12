import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import {
  JURISDICTION_PROFILES, addDaysIso, todayIso,
  type CompanyProfileInput, type LegalProfileSnapshot,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, companyProfileVersions } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { defaultVatRates, seedTaxRates } from '../settings/defaults';

export const PROFILE_ENGINE_VERSION = 'company-profile-v1';

export async function getCompanyProfile(tx: Tx, companyId: string) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound('Şirket');
  const profiles = await tx.select().from(companyProfileVersions).where(eq(companyProfileVersions.companyId, companyId)).orderBy(desc(companyProfileVersions.effectiveFrom));
  return { company, profiles, registry: Object.values(JURISDICTION_PROFILES) };
}

async function recordCounts(tx: Tx) {
  const selection=(await tx.execute<{value:string}>(sql`select current_setting('app.branch_selection',true) as value`)).rows[0]?.value??'';
  await tx.execute(sql`select set_config('app.branch_selection','all',true)`);
  const row = (await tx.execute<{ finalized: number; invoices: number; journals: number; payroll: number; declarations: number }>(sql`
    select (select count(*) from journal_entries where status='posted')::int
      + (select count(*) from invoices where status<>'draft')::int
      + (select count(*) from payroll_runs where status<>'draft')::int
      + (select count(*) from social_declarations where status='finalized')::int as finalized,
      (select count(*)::int from invoices where status='draft') as invoices,
      (select count(*)::int from journal_entries where status='draft') as journals,
      (select count(*)::int from payroll_runs where status='draft') as payroll,
      (select count(*)::int from social_declarations where status='draft') as declarations
  `)).rows[0]!;
  await tx.execute(sql`select set_config('app.branch_selection',${selection},true)`);
  return { finalizedRecordCount: Number(row.finalized), draftCounts: { invoices: Number(row.invoices), journalEntries: Number(row.journals), payrollRuns: Number(row.payroll), socialDeclarations: Number(row.declarations) } };
}

export async function previewCompanyProfile(tx: Tx, companyId: string, input: CompanyProfileInput) {
  const { company, profiles } = await getCompanyProfile(tx, companyId);
  const counts = await recordCounts(tx);
  const selected = JURISDICTION_PROFILES[input.jurisdiction];
  const currentProfile = profiles.find((p) => p.id === company.profileVersionId) ?? null;
  const blockers: { code: string; message: string }[] = [];
  if (input.effectiveFrom > todayIso()) blockers.push({ code: 'PROFILE_FUTURE_DATE', message: 'Ülke profili gelecek bir tarihte etkinleştirilemez.' });
  if (currentProfile && input.effectiveFrom <= currentProfile.effectiveFrom) blockers.push({ code: 'PROFILE_DATE_ORDER', message: 'Yeni profil başlangıcı mevcut profil başlangıcından sonra olmalı.' });
  if (company.jurisdiction && company.jurisdiction !== input.jurisdiction && counts.finalizedRecordCount > 0) {
    blockers.push({ code: 'COUNTRY_CHANGE_HAS_HISTORY', message: 'Kesinleşmiş mali kayıtları bulunan şirketin ülkesi değiştirilemez. Diğer ülkedeki tüzel kişilik için yeni şirket oluşturun.' });
  }
  const nextProfile = { ...input, activityCode: input.activityCode ?? null, timeZone: selected.timeZone, fxProvider: selected.fxProvider, rulePackVersion: selected.taxPackVersion, engineVersion: PROFILE_ENGINE_VERSION };
  const warnings = [
    'Geçmiş mali tutarlar ve oranlar değişmez. Taslaklar kaydedilmeden önce belge tarihine göre yeniden kontrol edilmelidir.',
    'KDV oran kümesi mal/hizmet sınıflandırmasını belirlemez; muhasebeci doğrulaması gerekir.',
    'Bordro, stopaj ve pul/damga kuralları kendi tarihli yapılandırmalarıyla değerlendirilir; ülke seçimi tam yasal uyum onayı değildir.',
  ];
  if (!company.jurisdiction) warnings.push('Eski ülkesiz kayıtlar manuel geçmiş olarak korunur; seçilen ülke yalnız yeni profil tarihinden itibaren uygulanır.');
  const revision = createHash('sha256').update(JSON.stringify({ company, currentProfile, input: nextProfile, counts })).digest('hex');
  return { canActivate: blockers.length === 0, blockers, warnings, currentProfile, nextProfile, ...counts, taxRatesToSeed: defaultVatRates(input.jurisdiction), revision };
}

export async function insertCompanyProfile(tx: Tx, companyId: string, userId: string, input: CompanyProfileInput) {
  const p = JURISDICTION_PROFILES[input.jurisdiction];
  const [profile] = await tx.insert(companyProfileVersions).values({
    companyId, ...input, activityCode: input.activityCode ?? null, timeZone: p.timeZone, fxProvider: p.fxProvider,
    rulePackVersion: p.taxPackVersion, engineVersion: PROFILE_ENGINE_VERSION,
    sourceRefs: [p.vatSourceUrl], createdBy: userId,
  }).returning();
  const [company] = await tx.update(companies).set({
    jurisdiction: input.jurisdiction, profileMode: 'country', profileVersionId: profile!.id,
    timeZone: p.timeZone, fxProvider: p.fxProvider, taxSetupStatus: 'needs_review',
    legalEntityType: input.legalEntityType, vatRegistered: input.vatRegistered, activityCode: input.activityCode ?? null,
  }).where(eq(companies.id, companyId)).returning();
  return { company: company!, profile: profile! };
}

export async function activateCompanyProfile(tx: Tx, companyId: string, userId: string, input: CompanyProfileInput, revision: string) {
  const preview = await previewCompanyProfile(tx, companyId, input);
  if (preview.revision !== revision) throw conflict('Şirket veya belgeler önizlemeden sonra değişti; ülke profilini yeniden önizleyin.', 'PROFILE_PREVIEW_STALE');
  if (!preview.canActivate) throw unprocessable(preview.blockers[0]!.message, preview.blockers[0]!.code, { blockers: preview.blockers });
  if (preview.currentProfile) {
    await tx.update(companyProfileVersions).set({ effectiveTo: addDaysIso(input.effectiveFrom, -1) }).where(eq(companyProfileVersions.id, preview.currentProfile.id));
  }
  const result = await insertCompanyProfile(tx, companyId, userId, input);
  await seedTaxRates(tx, companyId, input.jurisdiction, input.effectiveFrom);
  return result;
}

/** Belge tarihiyle seçilir; eski ülkesiz geçmişe yeni ülke atanmaz. */
export async function resolveLegalProfileSnapshot(tx: Tx, companyId: string, date: string): Promise<LegalProfileSnapshot | null> {
  const [company] = await tx.select({ mode: companies.profileMode }).from(companies).where(eq(companies.id, companyId));
  if (!company || company.mode === 'legacy_manual') return null;
  const [p] = await tx.select().from(companyProfileVersions).where(sql`${companyProfileVersions.companyId}=${companyId}::uuid and ${companyProfileVersions.effectiveFrom}<=${date}::date and (${companyProfileVersions.effectiveTo} is null or ${companyProfileVersions.effectiveTo}>=${date}::date)`).orderBy(desc(companyProfileVersions.effectiveFrom)).limit(1);
  if (!p) return null;
  return { jurisdiction: p.jurisdiction, profileVersionId: p.id, rulePackVersion: p.rulePackVersion, engineVersion: p.engineVersion, effectiveFrom: p.effectiveFrom, legalEntityType: p.legalEntityType, vatRegistered: p.vatRegistered, activityCode: p.activityCode, sourceRefs: p.sourceRefs };
}
