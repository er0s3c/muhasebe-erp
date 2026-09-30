import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { fmtDate, fmtDateTime, useLicense, type LicenseInfo, type LicenseState } from '../../lib/license';
import { OfflineActivation } from '../license/OfflineActivation';

const stateTone = { unlicensed: 'danger', active: 'success', grace: 'warning', restricted: 'danger' } as const satisfies Record<LicenseState, string>;

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid gap-1 border-b border-border px-5 py-3 last:border-b-0 sm:grid-cols-[220px_1fr] sm:gap-4" data-testid={testId}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Usage({ used, limit }: { used: number; limit: number }) {
  const full = used >= limit;
  return <span className={full ? 'text-warning' : undefined}>{used} / {limit}</span>;
}

export function LicensePage() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isPending, refetch } = useLicense();
  const [busy, setBusy] = useState<'refresh' | 'deactivate' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isPending || !data) return <PageLoading />;
  if (!data.enforced) {
    return (
      <>
        <PageHeader title={t('license.page.title')} description={t('license.page.subtitle')} />
        <Callout>{t('license.page.notEnforced')}</Callout>
      </>
    );
  }

  const l = data.license;
  const reload = async () => {
    await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ['public-config'] })]);
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      await api<LicenseInfo>('/api/license/refresh', { method: 'POST' });
      toast.success(t('license.page.refreshed'));
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async () => {
    setBusy('deactivate');
    try {
      await api<LicenseInfo>('/api/license/deactivate', { method: 'POST' });
      toast.success(t('license.page.moved'));
      setConfirmOpen(false);
      // Lisanssız kaldı: genel yapılandırma tazelenince etkinleştirme sayfası açılır
      await queryClient.invalidateQueries({ queryKey: ['public-config'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title={t('license.page.title')} description={t('license.page.subtitle')} />

      <div className="flex flex-col gap-6">
        {data.state === 'restricted' && <Callout tone="danger" title={t('license.banner.restrictedTitle')}>{data.message}</Callout>}
        {data.state === 'grace' && (
          <Callout tone="warning" title={t('license.banner.graceTitle')}>
            {t('license.banner.graceBody', { date: fmtDate(data.graceUntil) })}
          </Callout>
        )}

        <Card>
          <CardHeader title={t('license.page.status')} />
          <dl>
            <Row label={t('license.page.status')} testId="license-state">
              <Badge tone={stateTone[data.state]}>{t(`license.state.${data.state}`)}</Badge>
              {l?.offline && <Badge className="ml-2">{t('license.page.offlineBadge')}</Badge>}
            </Row>
            {l && (
              <>
                <Row label={t('license.page.customer')} testId="license-customer">{l.customer}</Row>
                <Row label={t('license.page.kind')}>{t(`license.kind.${l.kind}`)}</Row>
                <Row label={t('license.page.validUntil')}>
                  {fmtDate(l.validUntil)}
                  {data.daysUntilExpiry !== null && data.daysUntilExpiry >= 0 && (
                    <span className="ml-2 text-muted">({t('license.page.daysLeft', { count: data.daysUntilExpiry })})</span>
                  )}
                </Row>
                <Row label={t('license.page.leaseUntil')}>{fmtDate(data.activeUntil)}</Row>
                <Row label={t('license.page.graceUntil')}>{fmtDate(data.graceUntil)}</Row>
              </>
            )}
          </dl>
        </Card>

        {l && (
          <Card>
            <CardHeader title={t('license.page.scope')} />
            <dl>
              <Row label={t('license.page.sectors')} testId="license-sectors">
                <span className="flex flex-wrap gap-1.5">
                  {l.sectors.map((s) => (
                    <Badge key={s} tone="brand">{t(`sectors.${s}`)}</Badge>
                  ))}
                </span>
              </Row>
              <Row label={t('license.page.companies')} testId="license-companies">
                <Usage used={data.usage.companies} limit={l.companyLimit} />
              </Row>
              <Row label={t('license.page.devices')} testId="license-devices">
                <Usage used={data.usage.devices} limit={l.deviceLimit} />
                <Link to="/settings/devices" className="link ml-3">{t('license.page.manageDevices')}</Link>
              </Row>
            </dl>
          </Card>
        )}

        {data.isOwner && (
          <>
            <Card>
              <CardHeader
                title={t('license.page.install')}
                action={
                  data.serverConfigured ? (
                    <Button size="sm" loading={busy === 'refresh'} onClick={refresh}>{t('license.page.refresh')}</Button>
                  ) : undefined
                }
              />
              <dl>
                <Row label={t('license.page.installationId')} testId="license-installation">
                  <code className="break-all text-xs">{data.installationId}</code>
                  <p className="mt-1 text-xs text-muted">{t('license.page.installationHint')}</p>
                </Row>
                <Row label={t('license.page.fingerprint')}>
                  <Badge tone={data.fingerprintStrength === 'strong' ? 'success' : 'warning'}>
                    {data.fingerprintStrength === 'strong' ? t('license.page.fingerprintStrong') : t('license.page.fingerprintWeak')}
                  </Badge>
                  {data.fingerprintStrength === 'weak' && <p className="mt-1 text-xs text-muted">{t('license.page.fingerprintWeakHint')}</p>}
                </Row>
                <Row label={t('license.page.lastCheck')}>{fmtDateTime(data.lastCheckAt)}</Row>
                <Row label={t('license.page.lastSuccess')}>{fmtDateTime(data.lastSuccessAt)}</Row>
                {data.lastError && (
                  <Row label={t('license.page.lastError')}>
                    <span className="text-danger">{data.lastError.message}</span>
                  </Row>
                )}
              </dl>
              {!data.serverConfigured && <div className="px-5 pb-4"><Callout tone="warning">{t('license.page.serverNotConfigured')}</Callout></div>}
            </Card>

            <Card>
              <CardHeader title={t('license.offline.title')} />
              <div className="px-5 py-4">
                <OfflineActivation pendingRequest={data.pendingOfflineRequest} onActivated={async () => { toast.success(t('license.page.refreshed')); await reload(); }} />
              </div>
            </Card>

            {data.serverConfigured && (
              <Card>
                <CardHeader title={t('license.page.moveTitle')} />
                <div className="flex flex-col items-start gap-3 px-5 py-4">
                  <p className="text-sm text-muted">{t('license.page.moveBody')}</p>
                  <Button variant="danger" onClick={() => setConfirmOpen(true)}>{t('license.page.moveAction')}</Button>
                </div>
              </Card>
            )}
          </>
        )}

        <details className="rounded-xl border border-border px-4 py-3 text-sm">
          <summary className="cursor-pointer select-none">{t('license.sentTitle')}</summary>
          <p className="mt-3 text-muted">{t('license.sentBody')}</p>
        </details>
      </div>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('license.page.moveConfirmTitle')}
        description={t('license.page.moveConfirmBody')}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={busy === 'deactivate'} onClick={deactivate}>{t('license.page.moveConfirm')}</Button>
          </>
        }
      >
        <Callout tone="warning">{t('license.page.moveConfirmBody')}</Callout>
      </Modal>
    </>
  );
}
