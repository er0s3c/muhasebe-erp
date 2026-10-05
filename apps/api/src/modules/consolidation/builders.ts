import type { ExecutiveSummaryQuery, FxPositionQuery } from '@erp/shared';
import type { ReportTable } from '../../files/table';
import { forbidden } from '../../http/errors';
import type { BuildCtx } from '../exports/builders';
import { companyExecutive } from './executive';
import { companyFxPosition } from './fx-position';
import { executiveTables, fxPositionTables } from './tables';

function need(ctx: BuildCtx) {
  if (!ctx.access) throw forbidden();
  return ctx.access;
}

/** Şirket düzeyi dışa aktarma kayıtları (exports/registry.ts): ekrandaki rapor ile aynı servis fonksiyonları. */
export async function fxPositionBuild(ctx: BuildCtx, q: FxPositionQuery): Promise<ReportTable[]> {
  const a = need(ctx);
  return fxPositionTables(await companyFxPosition(ctx.tx, { companyId: a.companyId, name: ctx.company.name, baseCurrency: ctx.company.baseCurrency }, q));
}

export async function executiveBuild(ctx: BuildCtx, q: ExecutiveSummaryQuery): Promise<ReportTable[]> {
  const a = need(ctx);
  return executiveTables(
    await companyExecutive(ctx.tx, { companyId: a.companyId, name: ctx.company.name, baseCurrency: ctx.company.baseCurrency, reportingCurrency: ctx.company.reportingCurrency, permissions: a.permissions, enabledModules: a.enabledModules }, q),
  );
}
