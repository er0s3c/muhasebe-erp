import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { isoYear, todayIso, JURISDICTION_PROFILES, type CreateCompanyInput } from '@erp/shared';
import { setContext, type Tx } from '../../db/client';
import { companies, memberships, organizations, warehouses } from '../../db/schema';
import { seedChartOfAccounts } from '../ledger/accounts';
import { seedCostCodes } from '../projects/cost-codes';
import { seedMappings } from '../ledger/mappings';
import { seedTaxRates } from '../settings/defaults';
import { generatePeriods } from '../settings/periods';
import type { AuthUser } from '../../http/context';
import { forbidden } from '../../http/errors';
import { pinInstallationOwner } from '../../licensing/installation';
import { insertCompanyProfile } from './profiles';
import { withCompanyTimeZone } from '../../http/company-time';

/**
 * Yeni kuruluş (kayıt). `organizations` RLS ile yalıtıldığından kimlik önce üretilir ve işlem bağlamına (app.org_id)
 * yazılır; satır ancak bundan sonra eklenebilir/okunabilir. İşlem içinde çağrılmalıdır.
 */
export async function insertOrganization(tx: Tx, name: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(sql`select set_config('app.org_id', ${id}, true)`);
  await tx.insert(organizations).values({ id, name });
  return id;
}

/**
 * Yeni şirketi yalnızca kuruluşunda zaten sahip/yönetici olan kullanıcı açabilir; kuruluşun hiç şirketi yoksa (yeni kayıt)
 * ilk şirketi kaydolan kullanıcı açar. Aksi halde görüntüleyici bile kendi şirketini açıp "sahip" olabilirdi.
 * Kuruluş kilitlenir: aynı kuruluşta eşzamanlı iki "ilk şirket" isteği sırayla değerlendirilir.
 */
export async function assertCanCreateCompany(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp-company-create:' || app_org_id()::text))`);
  const [privileged] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, userId), inArray(memberships.role, ['owner', 'admin'])))
    .limit(1);
  if (privileged) return;
  const [any] = await tx.select({ id: companies.id }).from(companies).where(sql`${companies.organizationId} = app_org_id()`).limit(1);
  if (any) {
    throw forbidden('Yeni şirketi yalnızca mevcut bir şirketin sahibi ya da yöneticisi açabilir', 'COMPANY_CREATE_FORBIDDEN');
  }
}

/**
 * Şirketi ve varsayılanlarını (sahip üyeliği, cari yıl dönemleri, hesap planı,
 * KDV oranları, hesap eşlemesi, varsayılan depo) tek işlemde kurar. Herhangi bir adım başarısız olursa tümü geri alınır.
 */
export async function createCompany(
  tx: Tx,
  user: AuthUser,
  input: CreateCompanyInput,
  ip?: string,
  /** Lisans kuralları (denetim açıksa): sektör lisans kapsamında olmalı ve kuruluma toplam şirket sayısı sınırı aşılmamalı. */
  license?: { sectors: readonly string[]; companyLimit: number } | null,
) {
  if (license) {
    if (!license.sectors.includes(input.sector)) {
      throw forbidden('Lisansınız bu sektörü kapsamıyor', 'LICENSE_SECTOR_MISMATCH');
    }
    // Sayım ve ekleme arasında iki eşzamanlı istek sınırı birlikte aşmasın: kurulum genelinde tek kilit (işlem bitince kalkar).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp-license-company-limit'))`);
    const res = await tx.execute<{ n: number }>(sql`select license_company_count() as n`);
    if (Number(res.rows[0]?.n ?? 0) >= license.companyLimit) {
      throw forbidden(`Lisansınız en fazla ${license.companyLimit} şirkete izin veriyor`, 'LICENSE_COMPANY_LIMIT');
    }
  }
  const [company] = await tx
    .insert(companies)
    .values({
      organizationId: user.orgId,
      name: input.name,
      sector: input.sector,
      baseCurrency: input.baseCurrency,
      reportingCurrency: input.reportingCurrency,
      taxNumber: input.taxNumber ?? null,
      taxOffice: input.taxOffice ?? null,
      // Perakendede alış faturası satıştan sonra girilebildiği için negatif stok açık başlar.
      allowNegativeStock: input.sector === 'RETAIL_MARKET',
    })
    .returning({ id: companies.id });
  const companyId = company!.id;

  await tx.insert(memberships).values({ companyId, userId: user.id, role: 'owner' });
  // Kurulumun sahibi kuruluş henüz sabitlenmemişse (ilk şirket) şimdi sabitlenir; sonraki kuruluşlar kurulum yöneticisi olamaz.
  await pinInstallationOwner(tx);

  // Bundan sonraki eklemeler şirket bağlamında (RLS) yapılır.
  await setContext(tx, { userId: user.id, orgId: user.orgId, companyId, ip });

  await insertCompanyProfile(tx, companyId, user.id, { jurisdiction: input.jurisdiction, effectiveFrom: '1900-01-01', legalEntityType: input.legalEntityType, vatRegistered: input.vatRegistered, activityCode: input.activityCode });
  const currentDate = withCompanyTimeZone(JURISDICTION_PROFILES[input.jurisdiction].timeZone, () => todayIso());
  await generatePeriods(tx, companyId, isoYear(currentDate));
  await seedChartOfAccounts(tx, companyId);
  await seedMappings(tx, companyId, input.sector);
  await seedTaxRates(tx, companyId, input.jurisdiction);
  await seedCostCodes(tx, companyId);
  await tx.insert(warehouses).values({ companyId, code: 'ANA', name: 'Ana depo', isDefault: true });

  const [created] = await tx.select().from(companies).where(eq(companies.id, companyId));
  return created!;
}
