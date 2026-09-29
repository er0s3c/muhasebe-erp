import { eq } from 'drizzle-orm';
import { isoYear, todayIso, type CreateCompanyInput } from '@erp/shared';
import { setContext, type Tx } from '../../db/client';
import { companies, memberships, warehouses } from '../../db/schema';
import { seedChartOfAccounts } from '../ledger/accounts';
import { seedMappings } from '../ledger/mappings';
import { seedTaxRates } from '../settings/defaults';
import { generatePeriods } from '../settings/periods';
import type { AuthUser } from '../../http/context';

/**
 * Şirketi ve varsayılanlarını (sahip üyeliği, cari yıl dönemleri, hesap planı,
 * KDV oranları, hesap eşlemesi, varsayılan depo) tek işlemde kurar. Herhangi bir adım başarısız olursa tümü geri alınır.
 */
export async function createCompany(
  tx: Tx,
  user: AuthUser,
  input: CreateCompanyInput,
  ip?: string,
) {
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

  // Bundan sonraki eklemeler şirket bağlamında (RLS) yapılır.
  await setContext(tx, { userId: user.id, orgId: user.orgId, companyId, ip });

  await generatePeriods(tx, companyId, isoYear(todayIso()));
  await seedChartOfAccounts(tx, companyId);
  await seedMappings(tx, companyId, input.sector);
  await seedTaxRates(tx, companyId);
  await tx.insert(warehouses).values({ companyId, code: 'ANA', name: 'Ana depo', isDefault: true });

  const [created] = await tx.select().from(companies).where(eq(companies.id, companyId));
  return created!;
}
