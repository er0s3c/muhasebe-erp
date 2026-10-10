import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCESS_LEVELS, CUSTOM_ROLE_BASES, RESOURCE_OPERATIONS, RESOURCE_OPERATION_LABELS, isRoleBoundPermission, permissionLabel, permissionsOfArea, resourceOperationKey, type AccessAreaKey, type AccessLevel, type PermissionChoice, type Role } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { moduleName } from '../../lib/modules';
import { useCMutation, useCQuery } from '../../lib/queries';

type Access = { levels: Record<string, AccessLevel | 'default'>; permissions: Record<string, PermissionChoice>; operations: Record<string, PermissionChoice> };
export interface CompanyRole { id: string; name: string; baseRole: Role; access: Access; version: number; isActive: boolean; memberCount: number }
export interface CompanyRolesResponse { roles: CompanyRole[]; areas: AccessAreaKey[]; basePermissions: Partial<Record<Role, string[]>> }
const blank = (): Access => ({ levels: {}, permissions: {}, operations: {} });
const labels = { default: 'Temel role göre', none: 'Erişim yok', read: 'Sadece görüntüle', write: 'Görüntüle ve düzenle' };

export function CompanyRolesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const query = useCQuery<CompanyRolesResponse>(['company-roles'], '/api/company/roles');
  const [editing, setEditing] = useState<CompanyRole | 'new' | null>(null);
  const [name, setName] = useState('');
  const [baseRole, setBaseRole] = useState<Role>('viewer');
  const [access, setAccess] = useState<Access>(blank());
  const [active, setActive] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useCMutation((body: { name: string; baseRole: Role; access: Access; isActive: boolean }, call) => editing && editing !== 'new'
    ? call(`/api/company/roles/${editing.id}`, { method: 'PUT', body: { ...body, version: editing.version } })
    : call('/api/company/roles', { method: 'POST', body }), [['company-roles'], ['members'], ['navigation'], ['module-access'], ['export-access']]);
  const open = (role: CompanyRole | 'new') => {
    setEditing(role); setError(null); setSearch(''); setName(role === 'new' ? '' : role.name); setBaseRole(role === 'new' ? 'viewer' : role.baseRole);
    setAccess(role === 'new' ? blank() : role.access); setActive(role === 'new' || role.isActive);
  };
  const selectChoice = (section: 'permissions' | 'operations', key: string, choice: PermissionChoice) => setAccess(prev => ({ ...prev, [section]: { ...prev[section], [key]: choice } }));
  const areas = (query.data?.areas ?? []).filter(area => moduleName(area).toLocaleLowerCase('tr-TR').includes(search.trim().toLocaleLowerCase('tr-TR')));
  return <>
    <Card className="my-5 flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base">Özel şirket rolleri</h2><p className="text-sm text-muted">Aynı görevdeki üyelere ortak modül ve işlem izinleri tanımlayın.</p></div><Button onClick={() => open('new')} data-testid="company-role-add">Rol oluştur</Button></div>
      {query.isPending ? <PageLoading /> : query.error ? <Callout tone="danger">{errorMessage(query.error)}</Callout> : !query.data?.roles.length ? <p className="text-sm text-muted">Henüz özel şirket rolü yok.</p> : <ul className="divide-y divide-border">{query.data.roles.map(role => <li key={role.id} className="flex flex-wrap items-center justify-between gap-3 py-2"><span className="text-sm">{role.name} <span className="text-muted">· {t(`roles.${role.baseRole}`)} · {role.memberCount} üye{!role.isActive && ' · Pasif'}</span></span><Button size="sm" onClick={() => open(role)}>Düzenle</Button></li>)}</ul>}
    </Card>
    <Sheet wide open={editing !== null} onOpenChange={open => !open && setEditing(null)} title={editing === 'new' ? 'Şirket rolü oluştur' : 'Şirket rolünü düzenle'} description="Temel rol ve modül seçimleri birlikte uygulanır. İzin ver seçimi, temel erişim ve onay yetkisi sınırlarını aşamaz. Kaydedilen değişiklik rolün tüm üyelerine sonraki istekte uygulanır." footer={<><Button onClick={() => setEditing(null)}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ name, baseRole, access, isActive: active }, { onSuccess: () => { setEditing(null); toast.success('Şirket rolü kaydedildi'); }, onError: e => setError(errorMessage(e)) })} data-testid="company-role-save">Kaydet</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Rol adı" required>{id => <Input id={id} value={name} maxLength={100} onChange={e => setName(e.target.value)} />}</Field>
        <Field label="Temel kullanıcı rolü" hint="Onay ve hassas işlem hakları bu rolün izinleriyle sınırlıdır.">{id => <Select id={id} value={baseRole} disabled={editing !== null && editing !== 'new' && editing.memberCount > 0} onChange={e => setBaseRole(e.target.value as Role)}>{CUSTOM_ROLE_BASES.map(role => <option key={role} value={role}>{t(`roles.${role}`)}</option>)}</Select>}</Field>
        {editing !== 'new' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} disabled={!!editing?.memberCount} onChange={e => setActive(e.target.checked)} />Rol etkin</label>}
        <Field label="Modül ara">{id => <Input id={id} value={search} onChange={e => setSearch(e.target.value)} type="search" />}</Field>
        {areas.map(area => <details key={area} className="rounded-lg border border-border"><summary className="cursor-pointer p-3 text-sm">{moduleName(area)} · {labels[access.levels[area] ?? 'default']}</summary><div className="flex flex-col gap-3 border-t border-border p-3">
          <Select aria-label={`${moduleName(area)} temel erişim`} value={access.levels[area] ?? 'default'} onChange={e => setAccess(prev => ({ ...prev, levels: { ...prev.levels, [area]: e.target.value as AccessLevel | 'default' } }))}>{(['default', ...ACCESS_LEVELS] as const).map(level => <option key={level} value={level}>{labels[level]}</option>)}</Select>
          <div className="grid gap-3 sm:grid-cols-2">{RESOURCE_OPERATIONS.map(operation => { const key = resourceOperationKey(area, operation); return <label key={key} className="flex flex-col gap-1 text-xs">{RESOURCE_OPERATION_LABELS[operation]}<Select value={access.operations[key] ?? 'default'} onChange={e => selectChoice('operations', key, e.target.value as PermissionChoice)}><option value="default">Rol ve modül seçimine göre</option><option value="allow">İzin ver</option><option value="deny">Engelle</option></Select></label>; })}</div>
          <p className="text-xs text-muted">Dışa aktarma için raporun okuma izni de gerekir. Oluşturma, güncelleme ve silme için modülün düzenleme hakkı gerekir. Tüm şirket verilerini alma gibi hassas raporlar ayrıca role bağlıdır.</p>
          {permissionsOfArea(area).map(permission => <label key={permission} className="flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between"><span>{permissionLabel(permission)}{isRoleBoundPermission(permission) && ' · Role bağlı'}</span><Select className="sm:w-52" value={access.permissions[permission] ?? 'default'} onChange={e => selectChoice('permissions', permission, e.target.value as PermissionChoice)}><option value="default">Rol ve modül seçimine göre</option><option value="allow" disabled={isRoleBoundPermission(permission) && !query.data?.basePermissions[baseRole]?.includes(permission)}>İzin ver</option><option value="deny">Engelle</option></Select></label>)}
        </div></details>)}
      </div>
    </Sheet>
  </>;
}
