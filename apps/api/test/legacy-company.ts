import type { FastifyInstance } from 'fastify';
import { createCompany, execAsOwner } from './helpers';

/** Yalnız test: ülke alanları eklenmeden önceki, işlemsiz şirket durumunu canlandırır. */
export async function createLegacyCompany(app: FastifyInstance, token: string, overrides: Record<string, unknown> = {}) {
  const company = await createCompany(app, token, overrides);
  const result = await execAsOwner(`with closed as (update company_profile_versions set effective_to=effective_from where company_id=$1 and effective_to is null and not company_has_finalized_records(company_id) returning id) update companies set jurisdiction=null,profile_mode='legacy_manual',profile_version_id=null,fx_provider=null,tax_setup_status='legacy_manual',legal_entity_type=null,vat_registered=null,activity_code=null where id=$1 and not company_has_finalized_records(id)`, [company.id]);
  if (result.rowCount !== 1) throw new Error('Legacy test fixture işlemler oluşturulmadan hazırlanmalı');
  await execAsOwner(`update tax_rates set jurisdiction=null where company_id=$1 and source_note like 'Yalnız test%'`, [company.id]);
  return company;
}
