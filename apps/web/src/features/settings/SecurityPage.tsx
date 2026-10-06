import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { QrCode } from '../../components/ui/QrCode';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

/** Kullanıcının kendi hesabı için iki adımlı doğrulama (TOTP) yönetimi; şirket seçimi gerektirmez. */
export function SecurityPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api<MfaStatus>('/api/auth/mfa') });
  const refresh = async () => {await qc.invalidateQueries({ queryKey: ['mfa'] });await qc.invalidateQueries({predicate:q=>q.queryKey.includes('navigation')});};

  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<'disable' | 'regen' | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUri: string }>('/api/auth/mfa/setup', { method: 'POST' }),
    onSuccess: (r) => {
      setSetup(r);
      setCode('');
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const enable = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setSetup(null);
      setCodes(r.recoveryCodes);
      toast.success(t('security.enabledToast'));
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const disable = useMutation({
    mutationFn: () => api('/api/auth/mfa/disable', { method: 'POST', body: { password, code } }),
    onSuccess: () => {
      setDialog(null);
      toast.success(t('security.disabledToast'));
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const regen = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setDialog(null);
      setCodes(r.recoveryCodes);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const openDialog = (d: 'disable' | 'regen') => {
    setDialog(d);
    setCode('');
    setPassword('');
    setError(null);
  };
  const s = status.data;

  return (
    <>
      <PageHeader title={t('security.title')} description={t('security.subtitle')} />
      {status.isPending || !s ? (
        <PageLoading />
      ) : (
        <Card className="flex max-w-2xl flex-col gap-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-5 text-muted" aria-hidden />
              <div>
                <p>{t('security.status')}</p>
                {s.enabled && <p className="text-sm text-muted">{t('security.recoveryLeft', { count: s.recoveryCodesLeft })}</p>}
              </div>
            </div>
            <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? t('security.on') : t('security.off')}</Badge>
          </div>

          {!s.enabled && !setup && (
            <div>
              <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
                {t('security.enable')}
              </Button>
            </div>
          )}
          {s.enabled && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openDialog('regen')}>{t('security.regenerate')}</Button>
              <Button onClick={() => openDialog('disable')}>{t('security.disable')}</Button>
            </div>
          )}

          {setup && (
            <form
              className="flex flex-col gap-4 border-t border-border pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().length >= 6) enable.mutate();
              }}
            >
              <h2 className="text-base">{t('security.setupTitle')}</h2>
              <p className="text-sm text-muted">{t('security.setupStep1')}</p>
              <div className="flex flex-wrap items-start gap-6">
                <QrCode value={setup.otpauthUri} label={t('security.qrLabel')} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted">{t('security.manualKey')}</p>
                  <p className="mt-1 break-all font-mono text-sm tracking-wider">{setup.secret}</p>
                </div>
              </div>
              <p className="text-sm text-muted">{t('security.setupStep2')}</p>
              {error && <Callout tone="danger">{error}</Callout>}
              <Field label={t('security.code')}>
                {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="max-w-48" />}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.trim().length < 6}>
                  {t('security.confirm')}
                </Button>
                <Button type="button" onClick={() => setSetup(null)}>
                  {t('security.cancel')}
                </Button>
              </div>
            </form>
          )}
          {!setup && error && !dialog && <Callout tone="danger">{error}</Callout>}
        </Card>
      )}

      <Modal
        open={codes !== null}
        onOpenChange={(o) => !o && setCodes(null)}
        title={t('security.recoveryTitle')}
        footer={
          <>
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText((codes ?? []).join('\n')).then(() => toast.success(t('security.copied')));
              }}
            >
              <Copy className="size-4" aria-hidden />
              {t('security.copy')}
            </Button>
            <Button variant="primary" onClick={() => setCodes(null)}>
              {t('security.done')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Callout tone="warning">{t('security.recoveryWarn')}</Callout>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="recovery-codes">
            {(codes ?? []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </Modal>

      <Modal
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog === 'disable' ? t('security.disableTitle') : t('security.regenTitle')}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{t('security.cancel')}</Button>
            <Button
              variant="primary"
              loading={disable.isPending || regen.isPending}
              disabled={code.trim().length < 6 || (dialog === 'disable' && !password)}
              onClick={() => (dialog === 'disable' ? disable.mutate() : regen.mutate())}
            >
              {dialog === 'disable' ? t('security.disable') : t('security.regenerate')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{dialog === 'disable' ? t('security.disableHint') : t('security.regenHint')}</p>
          {error && <Callout tone="danger">{error}</Callout>}
          {dialog === 'disable' && (
            <Field label={t('security.password')}>
              {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          )}
          <Field label={t('security.code')}>
            {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}
