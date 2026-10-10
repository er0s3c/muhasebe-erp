import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCESS_LEVELS, MANUFACTURING_ACCESS_PROFILES, LEATHER_ACCESS_PROFILES, areaAccessOf, type AccessLevel, type AccessAreaKey, type Permission, type PermissionChoice } from '@erp/shared';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { moduleName } from '../../lib/modules';
import { useCMutation, useCQuery, useCompanyApi } from '../../lib/queries';
import type { Member } from '../../lib/types';
import { useCompany } from '../../lib/session';
import { Input, Select } from '../../components/ui/Field';

type Choice = AccessLevel | 'default';
const CHOICES: readonly Choice[] = ['default', ...ACCESS_LEVELS];

interface AreaView {
  key: string;
  label: string;
  labelKey: string;
  group: string;
  modules: { key: string; label: string; labelKey: string; enabled: boolean }[];
  roleDefault: { level: AccessLevel; partial: boolean };
  override: AccessLevel | null;
  effective: { level: AccessLevel; partial: boolean };
  setBy: string | null;
  operations: { key: Permission; label: string; roleDefault: boolean; inherited: boolean; override: 'allow' | 'deny' | null; effective: boolean; roleBound: boolean; canAllow: boolean }[];
  resourceOperations: { key: string; label: string; override: 'allow' | 'deny' | null; inherited: boolean; effective: boolean; canAllow: boolean }[];
}
interface AccessResponse {
  member: { userId: string; fullName: string; email: string; role: string };
  canEdit: boolean;
  blockedReason: string | null;
  areas: AreaView[];
}

const tone = (l: AccessLevel) => (l === 'none' ? 'danger' : l === 'read' ? 'warning' : 'success');

/**
 * Üyenin modül bazında erişimi (yalnızca sahip/yönetici): her modül için Rol varsayılanı / Erişim yok / Sadece görüntüle / Görüntüle ve
 * düzenle. Kaydetmeden önce değişiklik özeti onaylanır; sunucu rütbe ve verme sınırlarını ayrıca denetler.
 */
export function MemberAccessSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const sector = useCompany().sector;
  const { company, call } = useCompanyApi();
  const userId = member?.userId ?? null;
  const { data, isPending, error } = useCQuery<AccessResponse>(['module-access', userId ?? ''], userId ? `/api/company/members/${userId}/module-access` : null);
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [operationDraft, setOperationDraft] = useState<Record<string, PermissionChoice>>({});
  const [resourceDraft, setResourceDraft] = useState<Record<string, PermissionChoice>>({});
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'edit' | 'effective'>('edit');
  const [confirming, setConfirming] = useState(false);

  // Sunucudan gelen kayıtlı durumdan taslağı kur (üye değişince ya da kayıttan sonra)
  useEffect(() => {
    if (data) {
      setDraft(Object.fromEntries(data.areas.map((a) => [a.key, (a.override ?? 'default') as Choice])));
      setOperationDraft(Object.fromEntries(data.areas.flatMap((a) => a.operations.map((p) => [p.key, p.override ?? 'default']))));
      setResourceDraft(Object.fromEntries(data.areas.flatMap(a => a.resourceOperations.map(p => [p.key, p.override ?? 'default']))));
    }
  }, [data]);
  useEffect(() => {
    if (userId) { setTab('edit'); setSearch(''); setConfirming(false); }
  }, [userId]);

  const save = useCMutation(
    (body: { levels: Record<string, Choice>; permissions: Record<string, PermissionChoice>; operations: Record<string, PermissionChoice> }, call) => call(`/api/company/members/${userId}/module-access`, { method: 'PUT', body }),
    [['module-access', userId ?? ''], ['members']],
  );

  const levelLabel = (c: Choice) => t(`settings.members.access.level.${c}` as never);
  const areas = useMemo(() => data?.areas ?? [], [data]);
  const changes = useMemo(
    () => areas.filter((a) => (draft[a.key] ?? 'default') !== (a.override ?? 'default')),
    [areas, draft],
  );
  const operationChanges = useMemo(() => areas.flatMap((a) => a.operations.filter((p) => (operationDraft[p.key] ?? 'default') !== (p.override ?? 'default')).map((p) => ({ ...p, area: a.key }))), [areas, operationDraft]);
  const resourceChanges = useMemo(() => areas.flatMap(a => a.resourceOperations.filter(p => (resourceDraft[p.key] ?? 'default') !== (p.override ?? 'default')).map(p => ({ ...p, area: a.key }))), [areas, resourceDraft]);
  const previewBody = useMemo(() => ({
    levels: Object.fromEntries(changes.map(a => [a.key, draft[a.key] ?? 'default'])),
    permissions: Object.fromEntries(operationChanges.map(p => [p.key, operationDraft[p.key] ?? 'default'])),
    operations: Object.fromEntries(resourceChanges.map(p => [p.key, resourceDraft[p.key] ?? 'default'])),
  }), [changes, operationChanges, resourceChanges, draft, operationDraft, resourceDraft]);
  const hasChanges = changes.length + operationChanges.length + resourceChanges.length > 0;
  const preview = useQuery<{ permissions: Permission[]; resourceOperations: Record<string, boolean> }>({
    queryKey: [company.id, 'module-access-preview', userId, previewBody],
    queryFn: () => call(`/api/company/members/${userId}/module-access/preview`, { method: 'POST', body: previewBody }),
    enabled: !!data && !!userId && hasChanges,
  });
  const previewPermissions = useMemo(() => new Set<Permission>(hasChanges
    ? preview.data?.permissions ?? []
    : areas.flatMap(a => a.operations.filter(p => p.effective).map(p => p.key))), [hasChanges, preview.data, areas]);
  const grouped = useMemo(() => {
    const out = new Map<string, AreaView[]>();
    const needle = search.trim().toLocaleLowerCase('tr-TR');
    for (const a of areas) {
      if (needle && ![moduleName(a.key), ...a.modules.map((m) => moduleName(m.key)), ...a.operations.map((p) => p.label)].some((label) => label.toLocaleLowerCase('tr-TR').includes(needle))) continue;
      out.set(a.group, [...(out.get(a.group) ?? []), a]);
    }
    return [...out];
  }, [areas, search]);
  const editable = data?.canEdit === true;

  const previewAccess = (a: AreaView) => areaAccessOf(previewPermissions, a.key as AccessAreaKey);
  const operationLabel = (c: PermissionChoice) => c === 'allow' ? 'İzin ver' : c === 'deny' ? 'Engelle' : 'Modül seçimine göre';
  const resetOperations = () => { setOperationDraft(Object.fromEntries(areas.flatMap((a) => a.operations.map((p) => [p.key, 'default'])))); setResourceDraft(Object.fromEntries(areas.flatMap(a => a.resourceOperations.map(p => [p.key, 'default'])))); };
  const resetAll = () => { setDraft(Object.fromEntries(areas.map((a) => [a.key, 'default' as Choice]))); resetOperations(); };
  const changedCount = changes.length + operationChanges.length + resourceChanges.length;
  const resourceAllowed = (p: AreaView['resourceOperations'][number]) => hasChanges ? preview.data?.resourceOperations[p.key] === true : p.effective;

  const doSave = () => {
    const levels = Object.fromEntries(changes.map((a) => [a.key, draft[a.key] ?? 'default']));
    const permissions = Object.fromEntries(operationChanges.map((p) => [p.key, operationDraft[p.key] ?? 'default']));
    const operations = Object.fromEntries(resourceChanges.map(p => [p.key, resourceDraft[p.key] ?? 'default']));
    save.mutate({ levels, permissions, operations }, {
      onSuccess: () => {
        toast.success(t('settings.members.access.saved'));
        setConfirming(false);
        onClose();
      },
      onError: (e) => {
        setConfirming(false);
        toast.error(errorMessage(e));
      },
    });
  };

  return (
    <>
      <Sheet
        open={member !== null}
        onOpenChange={(o) => !o && onClose()}
        wide
        title={t('settings.members.access.title', { name: member?.fullName ?? '' })}
        description="Modül erişimini, kayıt oluşturma, güncelleme, silme, dışa aktarma ve onay haklarını ayrı yönetin. Özel şirket rolü ve temel kullanıcı rolü sınırları birlikte uygulanır."
        footer={
          <>
            {editable && (
              <Button className="mr-auto" onClick={resetAll} data-testid="access-reset-all">
                {t('settings.members.access.resetAll')}
              </Button>
            )}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {editable && (
              <Button variant="primary" disabled={changedCount === 0 || preview.isPending || !!preview.error} onClick={() => setConfirming(true)} data-testid="access-save">
                {t('settings.members.access.save')}
              </Button>
            )}
          </>
        }
      >
        {isPending ? (
          <PageLoading />
        ) : error || !data ? (
          <Callout tone="danger">{error ? errorMessage(error) : t('settings.members.access.loadFailed')}</Callout>
        ) : (
          <div className="flex flex-col gap-4">
            {!editable && data.blockedReason && <Callout tone="info">{data.blockedReason}</Callout>}
            {hasChanges && preview.isPending && <p className="text-xs text-muted">Etkin erişim önizlemesi hazırlanıyor…</p>}
            {hasChanges && preview.error && <Callout tone="danger">{errorMessage(preview.error)}</Callout>}
            {editable && ['MANUFACTURING_WHOLESALE','LEATHER_FASHION'].includes(sector) && (
              <label className="flex flex-col gap-1 text-sm">Üretim görev profili
                <Select defaultValue="" onChange={e=>{const profile=MANUFACTURING_ACCESS_PROFILES.find(p=>p.key===e.target.value);if(profile){setDraft(Object.fromEntries(areas.map(a=>[a.key,profile.levels[a.key as keyof typeof profile.levels]??'none'])));resetOperations();}}}>
                  <option value="">Profil seçin</option>{MANUFACTURING_ACCESS_PROFILES.filter(p=>p.role===member?.role).map(p=><option key={p.key} value={p.key}>{p.label}</option>)}
                </Select>
              </label>
            )}
            {editable && sector === 'LEATHER_FASHION' && member?.role === 'operator' && (
              <label className="flex flex-col gap-1 text-sm">
                Hazır görev profili
                <Select defaultValue="" onChange={(e) => {
                  const profile = LEATHER_ACCESS_PROFILES.find((p) => p.key === e.target.value);
                  if (profile) { setDraft(Object.fromEntries(areas.map((a) => [a.key, profile.levels[a.key as keyof typeof profile.levels] ?? 'none']))); resetOperations(); }
                }} data-testid="access-leather-profile">
                  <option value="">Görev profili seçin</option>
                  {LEATHER_ACCESS_PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </Select>
                <span className="text-xs text-muted">Seçim aşağıdaki erişimleri hazırlar. Kaydetmeden önce değişiklikleri kontrol edin; onay ve maliyet yetkileri role bağlıdır.</span>
              </label>
            )}
            <SegmentedTabs
              items={[
                { key: 'edit', label: t('settings.members.access.tabEdit') },
                { key: 'effective', label: t('settings.members.access.tabEffective') },
              ]}
              value={tab}
              onChange={setTab}
            />
            <label className="flex flex-col gap-1.5 text-sm">
              Modül veya işlem ara
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Örn. irsaliye, stok hareketi, onay" type="search" data-testid="access-search" />
            </label>
            {changedCount > 0 && <p className="text-xs text-muted">{changes.length} modül ve {operationChanges.length + resourceChanges.length} işlem izni değiştirildi. Kaydetmeden önce etkin erişimi kontrol edebilirsiniz.</p>}
            {tab === 'edit' ? (
              <div className="flex flex-col gap-5" data-testid="access-edit">
                {grouped.map(([group, list]) => (
                  <section key={group} aria-labelledby={`grp-${group}`}>
                    <h3 id={`grp-${group}`} className="mb-2 text-[13px] uppercase tracking-wide text-muted">
                      {t(`nav.groups.${group}` as never)}
                    </h3>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {list.map((a) => {
                        const cur = draft[a.key] ?? 'default';
                        const covered = a.modules.filter((m) => m.key !== a.key).map((m) => moduleName(m.key));
                        return (
                          <li key={a.key} className="flex flex-col gap-3 px-4 py-3" data-testid={`access-row-${a.key}`}>
                            <div className="min-w-0">
                              <div className="text-sm">{moduleName(a.key)}</div>
                              <div className="text-xs text-muted">
                                {t('settings.members.access.roleDefault', { level: levelLabel(a.roleDefault.level) })}
                                {a.roleDefault.partial && ` (${t('settings.members.access.partial')})`}
                              </div>
                              {covered.length > 0 && <div className="text-xs text-muted">{t('settings.members.access.covers', { modules: covered.join(', ') })}</div>}
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {a.resourceOperations.map(p => <label key={p.key} className="flex min-w-0 flex-col gap-1 text-xs">
                                {p.label} <span className="text-[12px] text-muted">{resourceAllowed(p) ? 'Etkin: izin var' : 'Etkin: engelli'}</span>
                                <Select aria-label={`${moduleName(a.key)}: ${p.label}`} value={resourceDraft[p.key] ?? 'default'} disabled={!editable || cur === 'none'} onChange={e => setResourceDraft(d => ({ ...d, [p.key]: e.target.value as PermissionChoice }))} data-testid={`access-resource-${p.key}`}>
                                  <option value="default">Rol ve modül seçimine göre</option><option value="allow" disabled={!p.canAllow}>İzin ver</option><option value="deny">Engelle</option>
                                </Select>
                              </label>)}
                            </div>
                            <div role="radiogroup" aria-label={t('settings.members.access.choose', { module: moduleName(a.key) })} className="grid grid-cols-2 gap-1.5 lg:grid-cols-4">
                              {CHOICES.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  role="radio"
                                  aria-checked={cur === c}
                                  disabled={!editable}
                                  data-testid={`access-${a.key}-${c}`}
                                  onClick={() => setDraft((d) => ({ ...d, [a.key]: c }))}
                                  className={cn(
                                    'min-w-0 rounded-md border px-3 py-2 text-left text-xs leading-relaxed transition-colors',
                                    cur === c ? 'border-border-strong bg-brand text-brand-contrast' : 'border-border text-muted hover:bg-surface-2 hover:text-text',
                                    !editable && 'cursor-not-allowed opacity-60',
                                  )}
                                >
                                  {levelLabel(c)}
                                </button>
                              ))}
                            </div>
                            <details className="rounded-lg bg-surface-2" data-testid={`access-details-${a.key}`}>
                              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">İşlem izinlerini ayrıntılı düzenle ({a.operations.length})</summary>
                              <div className="flex flex-col gap-3 border-t border-border p-3">
                                <p className="text-xs leading-relaxed text-muted">Modül seçimi temel hakları belirler. Aşağıdaki seçimler her işlemi ayrı değiştirir. Erişim yok seçiliyse tüm işlemler kapanır.</p>
                                {a.operations.map((p) => {
                                  const choice = operationDraft[p.key] ?? 'default';
                                  const allowed = previewPermissions.has(p.key);
                                  return <div key={p.key} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0 flex-1">
                                      <label htmlFor={`operation-${p.key}`} className="text-xs">{p.label}</label>
                                      <div className="text-[12px] text-muted">{allowed ? 'Etkin: izin var' : 'Etkin: engelli'}{p.roleBound && ' · Kullanıcı rolüyle sınırlı'}</div>
                                    </div>
                                    <Select id={`operation-${p.key}`} aria-label={`${moduleName(a.key)}: ${p.label}`} className="sm:w-48 sm:shrink-0" value={choice} disabled={!editable || cur === 'none'} onChange={(e) => setOperationDraft((d) => ({ ...d, [p.key]: e.target.value as PermissionChoice }))} data-testid={`access-operation-${p.key}`}>
                                      <option value="default">Modül seçimine göre</option>
                                      <option value="allow" disabled={!p.canAllow}>İzin ver</option>
                                      <option value="deny">Engelle</option>
                                    </Select>
                                  </div>;
                                })}
                              </div>
                            </details>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {grouped.length === 0 && <p className="text-sm text-muted">Aramanıza uygun modül veya işlem bulunamadı.</p>}
                <Callout tone="info">{t('settings.members.access.boundNote')}</Callout>
              </div>
            ) : (
              <div className="flex flex-col gap-3" data-testid="access-effective">
                <p className="text-sm text-muted">{t('settings.members.access.effectiveIntro')}</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {grouped.flatMap(([, list]) => list).map((a) => {
                    const preview = previewAccess(a);
                    const lvl = preview.level;
                    const dirty = (draft[a.key] ?? 'default') !== (a.override ?? 'default') || operationChanges.some((p) => p.area === a.key) || resourceChanges.some(p => p.area === a.key);
                    return (
                      <li key={a.key} className="flex flex-col gap-2 px-4 py-2.5" data-testid={`effective-${a.key}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">{moduleName(a.key)}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          {dirty && <span className="text-xs text-muted">{t('settings.members.access.preview')}</span>}
                          <Badge tone={tone(lvl)}>{levelLabel(lvl)}</Badge>
                          {preview.partial && <Badge>{t('settings.members.access.partial')}</Badge>}
                        </span>
                        </div>
                        <ul className="flex flex-col gap-1 text-xs text-muted">{a.operations.map((p) => <li key={p.key}>{p.label}: {previewPermissions.has(p.key) ? 'İzin var' : 'Engelli'}</li>)}</ul>
                        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{a.resourceOperations.map(p => <li key={p.key}>{p.label}: {resourceAllowed(p) ? 'İzin var' : 'Engelli'}</li>)}</ul>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </Sheet>

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.members.access.confirmTitle')}
        description={t('settings.members.access.confirmIntro', { name: member?.fullName ?? '' })}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={save.isPending} onClick={doSave} data-testid="access-confirm">
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="access-summary">
          {changedCount === 0 && <li className="text-muted">{t('settings.members.access.noChanges')}</li>}
          {changes.map((a) => (
            <li key={a.key}>
              {t('settings.members.access.changeLine', { module: moduleName(a.key), from: levelLabel((a.override ?? 'default') as Choice), to: levelLabel(draft[a.key] ?? 'default') })}
            </li>
          ))}
          {operationChanges.map((p) => <li key={p.key}>{moduleName(p.area)} — {p.label}: {operationLabel(p.override ?? 'default')} → {operationLabel(operationDraft[p.key] ?? 'default')}</li>)}
          {resourceChanges.map(p => <li key={p.key}>{moduleName(p.area)} — {p.label}: {operationLabel(p.override ?? 'default')} → {operationLabel(resourceDraft[p.key] ?? 'default')}</li>)}
        </ul>
      </Modal>
    </>
  );
}
