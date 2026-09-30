import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Textarea } from '../../components/ui/Field';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';

/**
 * Çevrimdışı etkinleştirme/yenileme: sunucu istek kodu üretir, satıcı imzalı lisansı geri gönderir, buraya yapıştırılır.
 * Hem etkinleştirme sayfasında (kimliksiz) hem Ayarlar > Lisans'ta (şirket sahibi) kullanılır.
 */
export function OfflineActivation({ pendingRequest, onActivated }: { pendingRequest?: boolean; onActivated: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [requestCode, setRequestCode] = useState<string | null>(null);
  const [lease, setLease] = useState('');
  const [busy, setBusy] = useState<'request' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createRequest = async () => {
    setBusy('request');
    setError(null);
    try {
      const res = await api<{ requestCode: string }>('/api/license/offline-request', { method: 'POST' });
      setRequestCode(res.requestCode);
      setCopied(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy('apply');
    setError(null);
    try {
      await api('/api/license/offline-activate', { method: 'POST', body: { lease: lease.trim() } });
      setLease('');
      await onActivated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!requestCode) return;
    try {
      await navigator.clipboard.writeText(requestCode);
      setCopied(true);
    } catch {
      /* pano izni yok: kullanıcı metni elle seçip kopyalar */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('license.offline.intro')}</p>
      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex flex-col gap-2">
        <p className="text-sm">{t('license.offline.step1')}</p>
        {pendingRequest && !requestCode && <Callout>{t('license.offline.pending')}</Callout>}
        <div>
          <Button size="sm" loading={busy === 'request'} onClick={createRequest}>
            {t('license.offline.create')}
          </Button>
        </div>
        {requestCode && (
          <Field label={t('license.offline.code')}>
            {(id) => (
              <div className="flex flex-col gap-2">
                <Textarea id={id} readOnly rows={4} value={requestCode} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <div>
                  <Button size="sm" variant="ghost" onClick={copy}>
                    {copied ? t('license.offline.copied') : t('license.offline.copy')}
                  </Button>
                </div>
              </div>
            )}
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm">{t('license.offline.step2')}</p>
        <Field label={t('license.offline.lease')}>
          {(id) => <Textarea id={id} rows={4} value={lease} onChange={(e) => setLease(e.target.value)} className="font-mono text-xs" spellCheck={false} />}
        </Field>
        <div>
          <Button size="sm" variant="primary" disabled={lease.trim().length < 50} loading={busy === 'apply'} onClick={apply}>
            {t('license.offline.apply')}
          </Button>
        </div>
      </div>
    </div>
  );
}
