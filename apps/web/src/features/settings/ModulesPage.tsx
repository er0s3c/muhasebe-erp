import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModuleDescription } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Card, PageHeader } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

export function ModulesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const editable = can('settings.manage');
  const { data, isPending } = useCQuery<{ modules: ModuleDescription[] }>(['modules'], '/api/company/modules');
  const [pending, setPending] = useState<string | null>(null);

  const toggle = useCMutation(
    (v: { key: string; enabled: boolean }, call) =>
      call<{ modules: ModuleDescription[] }>(`/api/company/modules/${v.key}`, { method: 'PUT', body: { enabled: v.enabled } }),
    // Menü, sayfa kapıları ve panel sayaçları bu anahtarlara bağlıdır
    [['modules'], ['navigation'], ['dashboard']],
  );

  if (isPending || !data) return <PageLoading />;
  const labelKeys = new Map(data.modules.map((m) => [m.key, m.labelKey]));
  const nameOf = (key: string) => String(t((labelKeys.get(key) ?? 'modules.dashboard') as never));
  const list = (keys: string[]) => keys.map(nameOf).join(', ');

  const blockedText = (m: ModuleDescription): string | null => {
    if (!m.blocked) return null;
    const modules = list(m.blocked.modules);
    return String(t(`settings.modules.blocked.${m.blocked.reason}` as never, { modules } as never));
  };

  return (
    <>
      <PageHeader title={t('settings.modules.title')} description={t('settings.modules.subtitle')} />
      {!editable && (
        <div className="mb-4">
          <Callout tone="info">{t('settings.modules.readOnly')}</Callout>
        </div>
      )}
      <Card>
        <ul>
          {data.modules.map((m) => {
            const planned = m.status === 'planned';
            const offSector = !m.sectorDefault && !planned;
            const blocked = blockedText(m);
            // Yalnızca değiştirilebilir durumdaki (engeli olmayan) modüller anahtarla oynanır
            const disabled = !editable || m.blocked !== null;
            return (
              <li key={m.key} className="flex items-start gap-4 border-b border-border px-5 py-4 last:border-b-0" data-testid={`module-${m.key}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{nameOf(m.key)}</span>
                    {m.locked && <Badge>{t('settings.modules.locked')}</Badge>}
                    {planned && <Badge tone="warning">{t('settings.modules.planned')}</Badge>}
                    {offSector && <Badge>{t('settings.modules.notInSector')}</Badge>}
                    {!planned && !offSector && !m.locked && (
                      <Badge tone={m.enabled ? 'success' : 'neutral'}>{m.enabled ? t('settings.modules.enabled') : t('settings.modules.disabled')}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted">{t(`settings.modules.desc.${m.key}` as never)}</p>
                  {m.requires.length > 0 && (
                    <p className="mt-1 text-xs text-muted">{t('settings.modules.requires', { modules: list(m.requires) })}</p>
                  )}
                  {blocked && !planned && !offSector && <p className="mt-1 text-xs text-muted">{blocked}</p>}
                </div>
                <Switch
                  checked={m.enabled}
                  disabled={disabled}
                  loading={pending === m.key}
                  label={`${nameOf(m.key)}: ${m.enabled ? t('settings.modules.turnOff') : t('settings.modules.turnOn')}`}
                  onChange={(next) => {
                    setPending(m.key);
                    toggle.mutate(
                      { key: m.key, enabled: next },
                      {
                        onSuccess: () => toast.success(t(next ? 'settings.modules.onMsg' : 'settings.modules.offMsg', { module: nameOf(m.key) })),
                        onError: (e) => toast.error(errorMessage(e)),
                        onSettled: () => setPending(null),
                      },
                    );
                  }}
                />
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
