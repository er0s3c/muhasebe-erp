import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { cn } from '../../lib/cn';
import { money } from '../../lib/format';
import { useCan, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { ProjectKind, ProjectOption, ProjectStatus } from '../../lib/types';

/** Proje/iş kalemi/bütçe/ilerleme değişince etkilenen sorgular. */
export const PROJECT_INVALIDATE = [['projects'], ['project']];

/** Maliyet yazan formlar (yevmiye, fatura, stok, kasa) kayıttan sonra proje raporlarını da tazeler. */
export const PROJECT_COST_INVALIDATE = [['projects'], ['project']];

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'on_hold', 'completed', 'cancelled'];

const STATUS_TONE = { planned: 'neutral', active: 'success', on_hold: 'warning', completed: 'brand', cancelled: 'danger' } as const;

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`projects.status.${status}`)}</Badge>;
}

export function ProjectKindBadge({ kind }: { kind: ProjectKind }) {
  const { t } = useTranslation();
  return <Badge tone={kind === 'contract' ? 'warning' : 'neutral'}>{t(`projects.kinds.${kind}`)}</Badge>;
}

/**
 * Sapma (bütçe − tahmini toplam): eksi = aşım. Renk tek başına taşıyıcı değildir: simge ve metin de aynı bilgiyi verir.
 */
export function VarianceText({ value, className }: { value: string; className?: string }) {
  const { t } = useTranslation();
  const n = Number(value);
  if (n === 0) return <span className={cn('text-muted', className)}>{money(value)}</span>;
  if (n < 0) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-danger', className)} title={t('projects.overrun')}>
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        <span className="sr-only">{t('projects.overrun')}: </span>
        {money(value)}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-success', className)} title={t('projects.saving')}>
      <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{t('projects.saving')}: </span>+{money(value)}
    </span>
  );
}

/** Seçicilerin kaynağı: maliyet etiketi alabilen açık projeler ve aktif yaprak iş kalemleri. */
export function useProjectOptions(enabled = true) {
  const can = useCan();
  const moduleOn = useModuleEnabled('construction.projects');
  const allowed = enabled && moduleOn && can('projects.read');
  const { data } = useCQuery<{ projects: ProjectOption[] }>(['projects', 'options'], '/api/projects/options', { enabled: allowed });
  const projects = useMemo(() => data?.projects ?? [], [data]);
  return { allowed, projects, byId: useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]) };
}

const NONE = '';

interface FieldsProps {
  projectId: string;
  wbsId: string;
  onChange: (next: { projectId: string; wbsId: string }) => void;
  disabled?: boolean;
  /** Satır içi (sıkı) yerleşim: etiketsiz, yan yana. */
  compact?: boolean;
  /** Erişilebilir ad öneki (e2e ve ekran okuyucu için satır numarası gibi). */
  label?: string;
}

/**
 * Proje + yaprak iş kalemi seçicisi. Modül kapalıysa ya da kullanıcının `projects.read` izni yoksa hiçbir şey çizmez.
 * Proje değişince iş kalemi sıfırlanır; "Proje yok" seçeneği ikisini de temizler.
 */
export function ProjectWbsFields({ projectId, wbsId, onChange, disabled, compact, label }: FieldsProps) {
  const { t } = useTranslation();
  const { allowed, projects, byId } = useProjectOptions();
  const projectOptions = useMemo<ComboOption[]>(
    () => [
      { value: NONE, label: t('projects.picker.none') },
      ...projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` })),
    ],
    [projects, t],
  );
  const wbsOptions = useMemo<ComboOption[]>(() => {
    const project = byId.get(projectId);
    return [{ value: NONE, label: t('projects.picker.noWbs') }, ...(project?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}`, keywords: `${w.code} ${w.name}` }))];
  }, [byId, projectId, t]);
  if (!allowed) return null;

  const suffix = label ? ` ${label}` : '';
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 md:grid-cols-2')}>
      <Combobox
        aria-label={`${t('projects.picker.project')}${suffix}`}
        options={projectOptions}
        value={projectId}
        placeholder={t('projects.picker.project')}
        disabled={disabled}
        onChange={(v) => onChange({ projectId: v, wbsId: NONE })}
      />
      <Combobox
        aria-label={`${t('projects.picker.wbs')}${suffix}`}
        options={wbsOptions}
        value={wbsId}
        placeholder={t('projects.picker.wbs')}
        disabled={disabled || !projectId}
        onChange={(v) => onChange({ projectId, wbsId: v })}
      />
    </div>
  );
}

/** API gövdesine eklenecek alanlar: boş seçim hiç gönderilmez. */
export const projectFields = (projectId: string, wbsId: string) => (projectId ? { projectId, ...(wbsId ? { wbsId } : {}) } : {});

/** Yevmiye satırında proje etiketi alabilen hesap türleri (sunucu kuralıyla aynı: gelir, gider, maliyet). */
export const isProjectTaggable = (account: { type: string } | undefined | null) => !!account && ['income', 'expense', 'cost'].includes(account.type);

/**
 * Form satırı altındaki gri alt satır: "Proje" etiketi + seçici çifti. Modül kapalı ya da izin yoksa hiçbir şey çizmez.
 * `className` çağıran formun ızgarasına uyum içindir (ör. `col-span-full`).
 */
export function ProjectLineRow({ projectId, wbsId, onChange, label, className, disabled }: FieldsProps & { className?: string }) {
  const { t } = useTranslation();
  const { allowed } = useProjectOptions();
  if (!allowed) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-2 px-3 py-2', className)}>
      <span className="text-xs text-muted" title={t('projects.picker.hint')}>
        {t('projects.picker.label')}
      </span>
      <div className="min-w-72 flex-1">
        <ProjectWbsFields projectId={projectId} wbsId={wbsId} onChange={onChange} label={label} disabled={disabled} compact />
      </div>
    </div>
  );
}
