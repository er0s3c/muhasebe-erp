import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery } from '../../lib/queries';
import type { NotificationPreference, NotificationPreferences } from '../../lib/types';
import { NOTIFICATION_INVALIDATE } from './common';

interface Change {
  kind: NotificationPreference['kind'];
  inApp?: boolean;
  email?: boolean;
  leadDays?: number | null;
}

/** Gün eşiği: boş = varsayılan (kaynak ayarı ya da düz varsayılan). Alan kapanınca (odak çıkınca / Enter) kaydedilir. */
function LeadInput({ pref, disabled, onCommit }: { pref: NotificationPreference; disabled: boolean; onCommit: (value: number | null) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(pref.leadDays === null ? '' : String(pref.leadDays));
  useEffect(() => setText(pref.leadDays === null ? '' : String(pref.leadDays)), [pref.leadDays]);
  const commit = () => {
    const next = text.trim() === '' ? null : Number(text);
    if (next !== null && !Number.isInteger(next)) {
      setText(pref.leadDays === null ? '' : String(pref.leadDays));
      return;
    }
    if (next !== pref.leadDays) onCommit(next);
  };
  const unit = pref.leadUnit ?? 'ahead';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`lead-${pref.kind}`} className="text-[13px] text-text">
        {t(`notifications.leadUnit.${unit}`)}
      </label>
      <Input
        id={`lead-${pref.kind}`}
        type="number"
        inputMode="numeric"
        min={pref.leadMin ?? 0}
        max={pref.leadMax ?? 365}
        step={1}
        className="w-28"
        placeholder={String(pref.leadDefault ?? '')}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <p className="text-xs text-muted">
        {pref.leadDays === null
          ? pref.leadFromSetting
            ? t('notifications.leadFromSetting', { days: pref.leadDefault ?? 0 })
            : t('notifications.leadDefault', { days: pref.leadDefault ?? 0 })
          : t('notifications.leadRange', { min: pref.leadMin ?? 0, max: pref.leadMax ?? 365 })}
      </p>
    </div>
  );
}

/**
 * Bildirim tercihleri (kullanıcı başına, şirket başına): tür başına uygulama içi / e-posta özeti açma-kapama ve gün eşiği.
 * Değişiklik anında kaydedilir. E-posta özeti yalnızca sunucuda SMTP yapılandırılmışsa kullanılabilir ve varsayılan KAPALIDIR.
 * Yalnızca bu şirkette ve rolünüzde kullanılabilen türler listelenir.
 */
export function NotificationPreferencesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { data, isPending, error } = useCQuery<NotificationPreferences>(['notifications', 'prefs'], '/api/notification-preferences', { staleTime: 0 });
  const save = useCMutation((c: Change, call) => call<NotificationPreferences>('/api/notification-preferences', { method: 'PUT', body: { preferences: [c] } }), NOTIFICATION_INVALIDATE);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const apply = (c: Change, field: string) => {
    setBusyKey(`${c.kind}:${field}`);
    save.mutate(c, {
      onSuccess: () => toast.success(t('notifications.prefSaved')),
      onError: (e) => toast.error(errorMessage(e)),
      onSettled: () => setBusyKey(null),
    });
  };

  return (
    <>
      <PageHeader title={t('notifications.prefTitle')} description={t('notifications.prefSubtitle')} actions={<Link to="/notifications" className="text-sm link">{t('notifications.backToList')}</Link>} />
      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          {!data.emailAvailable && <Callout tone="info">{t('notifications.emailUnavailable')}</Callout>}
          <Callout tone="info">{t('notifications.emailPrivacy')}</Callout>
          <Card>
            <CardHeader title={t('notifications.prefKinds')} description={t('notifications.prefKindsDesc')} />
            <ul className="divide-y divide-border" data-testid="notification-prefs">
              {data.kinds.map((p) => {
                const label = t(`notifications.kinds.${p.kind}.label`);
                return (
                  <li key={p.kind} className="flex flex-wrap items-start gap-x-8 gap-y-4 px-5 py-4" data-kind={p.kind}>
                    <div className="min-w-0 flex-1 basis-72">
                      <p className="text-sm">{label}</p>
                      <p className="mt-0.5 text-[13px] text-muted">{t(`notifications.kinds.${p.kind}.desc`)}</p>
                    </div>
                    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[13px] text-text">{t('notifications.inApp')}</span>
                        <Switch checked={p.inApp} label={`${label}: ${t('notifications.inApp')}`} loading={busyKey === `${p.kind}:inApp`} onChange={(v) => apply({ kind: p.kind, inApp: v }, 'inApp')} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[13px] text-text">{t('notifications.emailDigest')}</span>
                        <Switch
                          checked={p.email}
                          label={`${label}: ${t('notifications.emailDigest')}`}
                          disabled={!data.emailAvailable || !p.inApp}
                          loading={busyKey === `${p.kind}:email`}
                          onChange={(v) => apply({ kind: p.kind, email: v }, 'email')}
                        />
                        {data.emailAvailable && !p.inApp && <p className="max-w-40 text-xs text-muted">{t('notifications.emailNeedsInApp')}</p>}
                      </div>
                      {p.leadUnit && <LeadInput pref={p} disabled={busyKey === `${p.kind}:lead`} onCommit={(v) => apply({ kind: p.kind, leadDays: v }, 'lead')} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
