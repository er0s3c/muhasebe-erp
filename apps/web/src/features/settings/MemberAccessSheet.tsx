import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCESS_LEVELS, type AccessLevel } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { moduleName } from '../../lib/modules';
import { useCMutation, useCQuery } from '../../lib/queries';
import type { Member } from '../../lib/types';

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
  const userId = member?.userId ?? null;
  const { data, isPending, error } = useCQuery<AccessResponse>(['module-access', userId ?? ''], userId ? `/api/company/members/${userId}/module-access` : null);
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [tab, setTab] = useState<'edit' | 'effective'>('edit');
  const [confirming, setConfirming] = useState(false);

  // Sunucudan gelen kayıtlı durumdan taslağı kur (üye değişince ya da kayıttan sonra)
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.areas.map((a) => [a.key, (a.override ?? 'default') as Choice])));
  }, [data]);
  useEffect(() => {
    if (userId) setTab('edit');
  }, [userId]);

  const save = useCMutation(
    (levels: Record<string, Choice>, call) => call(`/api/company/members/${userId}/module-access`, { method: 'PUT', body: { levels } }),
    [['module-access', userId ?? ''], ['members']],
  );

  const levelLabel = (c: Choice) => t(`settings.members.access.level.${c}` as never);
  const areas = useMemo(() => data?.areas ?? [], [data]);
  const changes = useMemo(
    () => areas.filter((a) => (draft[a.key] ?? 'default') !== (a.override ?? 'default')),
    [areas, draft],
  );
  const grouped = useMemo(() => {
    const out = new Map<string, AreaView[]>();
    for (const a of areas) out.set(a.group, [...(out.get(a.group) ?? []), a]);
    return [...out];
  }, [areas]);
  const editable = data?.canEdit === true;

  const previewLevel = (a: AreaView): AccessLevel => {
    const c = draft[a.key] ?? 'default';
    return c === 'default' ? a.roleDefault.level : c;
  };

  const doSave = () => {
    const levels = Object.fromEntries(changes.map((a) => [a.key, draft[a.key] ?? 'default']));
    save.mutate(levels, {
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
        description={t('settings.members.access.description')}
        footer={
          <>
            {editable && (
              <Button className="mr-auto" onClick={() => setDraft(Object.fromEntries(areas.map((a) => [a.key, 'default' as Choice])))} data-testid="access-reset-all">
                {t('settings.members.access.resetAll')}
              </Button>
            )}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {editable && (
              <Button variant="primary" disabled={changes.length === 0} onClick={() => setConfirming(true)} data-testid="access-save">
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
            <SegmentedTabs
              items={[
                { key: 'edit', label: t('settings.members.access.tabEdit') },
                { key: 'effective', label: t('settings.members.access.tabEffective') },
              ]}
              value={tab}
              onChange={setTab}
            />
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
                          <li key={a.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`access-row-${a.key}`}>
                            <div className="min-w-0">
                              <div className="text-sm">{moduleName(a.key)}</div>
                              <div className="text-xs text-muted">
                                {t('settings.members.access.roleDefault', { level: levelLabel(a.roleDefault.level) })}
                                {a.roleDefault.partial && ` (${t('settings.members.access.partial')})`}
                              </div>
                              {covered.length > 0 && <div className="text-xs text-muted">{t('settings.members.access.covers', { modules: covered.join(', ') })}</div>}
                            </div>
                            <div role="radiogroup" aria-label={t('settings.members.access.choose', { module: moduleName(a.key) })} className="grid grid-cols-2 gap-1 sm:flex sm:flex-wrap">
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
                                    'rounded-md border px-3 py-1.5 text-left text-xs transition-colors sm:text-center',
                                    cur === c ? 'border-border-strong bg-brand text-brand-contrast' : 'border-border text-muted hover:bg-surface-2 hover:text-text',
                                    !editable && 'cursor-not-allowed opacity-60',
                                  )}
                                >
                                  {levelLabel(c)}
                                </button>
                              ))}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                <Callout tone="info">{t('settings.members.access.boundNote')}</Callout>
              </div>
            ) : (
              <div className="flex flex-col gap-3" data-testid="access-effective">
                <p className="text-sm text-muted">{t('settings.members.access.effectiveIntro')}</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {areas.map((a) => {
                    const lvl = previewLevel(a);
                    const dirty = (draft[a.key] ?? 'default') !== (a.override ?? 'default');
                    return (
                      <li key={a.key} className="flex items-center justify-between gap-3 px-4 py-2.5" data-testid={`effective-${a.key}`}>
                        <span className="text-sm">{moduleName(a.key)}</span>
                        <span className="flex items-center gap-2">
                          {dirty && <span className="text-xs text-muted">{t('settings.members.access.preview')}</span>}
                          <Badge tone={tone(lvl)}>{levelLabel(lvl)}</Badge>
                          {!dirty && a.effective.partial && <Badge>{t('settings.members.access.partial')}</Badge>}
                        </span>
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
          {changes.length === 0 && <li className="text-muted">{t('settings.members.access.noChanges')}</li>}
          {changes.map((a) => (
            <li key={a.key}>
              {t('settings.members.access.changeLine', { module: moduleName(a.key), from: levelLabel((a.override ?? 'default') as Choice), to: levelLabel(draft[a.key] ?? 'default') })}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
