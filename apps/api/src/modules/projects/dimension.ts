import { eq, inArray } from 'drizzle-orm';
import {
  PROJECT_OPEN_STATUSES,
  PROJECT_TAGGABLE_ACCOUNT_TYPES,
  resolveEnabledModules,
  type ProjectStatus,
  type Sector,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, companyModules, projects, projectWbs } from '../../db/schema';
import { unprocessable } from '../../http/errors';

/** Bir kaydın (yevmiye satırı, fatura satırı, stok satırı) proje boyutu. */
export interface DimensionLine {
  /** Hata iletisi öneki (ör. "Satır 3"). */
  label: string;
  projectId?: string | null;
  wbsId?: string | null;
  /** Yevmiye satırında hesap türü; verilirse gelir/gider/maliyet olmalı. */
  accountType?: string;
}

export async function isProjectsModuleEnabled(tx: Tx, companyId: string): Promise<boolean> {
  const [company] = await tx.select({ sector: companies.sector }).from(companies).where(eq(companies.id, companyId));
  if (!company) return false;
  const overrides = await tx.select({ module: companyModules.module, enabled: companyModules.enabled }).from(companyModules);
  return resolveEnabledModules(company.sector as Sector, overrides).has('construction.projects');
}

/**
 * Proje/iş kalemi etiketlerini uygulama düzeyinde doğrular (kullanıcıya anlaşılır hata); asıl koruma veritabanı
 * tetikleyicileridir (ERP09). Etiket yoksa hiçbir sorgu yapmaz.
 * `allowClosedProject`: ters kayıt gibi önceki etiketi nötrleyen yazımlar tamamlanmış projeye de yazılabilir.
 */
export async function validateDimensions(
  tx: Tx,
  companyId: string,
  lines: readonly DimensionLine[],
  opts: { allowClosedProject?: boolean } = {},
): Promise<void> {
  const tagged = lines.filter((l) => l.projectId || l.wbsId);
  if (tagged.length === 0) return;

  for (const l of tagged) {
    if (l.wbsId && !l.projectId) throw unprocessable(`${l.label}: iş kalemi için proje seçilmeli`, 'WBS_WITHOUT_PROJECT');
    if (l.accountType !== undefined && !(PROJECT_TAGGABLE_ACCOUNT_TYPES as readonly string[]).includes(l.accountType)) {
      throw unprocessable(`${l.label}: proje yalnızca gelir, gider ve maliyet hesaplarına etiketlenebilir`, 'PROJECT_ACCOUNT_NOT_ALLOWED');
    }
  }

  if (!(await isProjectsModuleEnabled(tx, companyId))) {
    throw unprocessable('Proje etiketi için "Şantiye ve projeler" modülü etkin olmalı', 'PROJECT_MODULE_DISABLED');
  }

  const projectIds = [...new Set(tagged.map((l) => l.projectId!))];
  const projectRows = await tx.select().from(projects).where(inArray(projects.id, projectIds));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const wbsIds = [...new Set(tagged.map((l) => l.wbsId).filter((w): w is string => !!w))];
  const wbsRows = wbsIds.length ? await tx.select().from(projectWbs).where(inArray(projectWbs.id, wbsIds)) : [];
  const wbsById = new Map(wbsRows.map((w) => [w.id, w]));
  // Yaprak denetimi: alt düğümü olan iş kalemleri
  const parents = wbsIds.length
    ? new Set(
        (await tx.select({ parentId: projectWbs.parentId }).from(projectWbs).where(inArray(projectWbs.parentId, wbsIds))).map((r) => r.parentId),
      )
    : new Set<string | null>();

  for (const l of tagged) {
    const project = projectById.get(l.projectId!);
    if (!project) throw unprocessable(`${l.label}: proje bulunamadı`, 'PROJECT_NOT_FOUND');
    if (!opts.allowClosedProject && !PROJECT_OPEN_STATUSES.includes(project.status as ProjectStatus)) {
      throw unprocessable(`${l.label}: ${project.code} projesi tamamlanmış veya iptal edilmiş; yeni kayıt yazılamaz`, 'PROJECT_CLOSED');
    }
    if (l.wbsId) {
      const wbs = wbsById.get(l.wbsId);
      if (!wbs || wbs.projectId !== project.id) {
        throw unprocessable(`${l.label}: iş kalemi ${project.code} projesine ait değil`, 'WBS_NOT_FOUND');
      }
      if (parents.has(wbs.id)) {
        throw unprocessable(`${l.label}: ${wbs.code} iş kaleminin alt işleri var; kayıt yalnızca alt işi olmayan iş kalemine yazılır`, 'WBS_NOT_LEAF');
      }
      if (!wbs.isActive && !opts.allowClosedProject) {
        throw unprocessable(`${l.label}: ${wbs.code} iş kalemi pasif`, 'WBS_INACTIVE');
      }
    }
  }
}
