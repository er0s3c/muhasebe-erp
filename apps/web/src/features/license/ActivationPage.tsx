import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { AuthLayout } from '../auth/AuthLayout';
import { OfflineActivation } from './OfflineActivation';

/** Yazılan kodu büyük harfe çevirir, tire/boşlukları atar, 5'erli gruplar (en çok 25 karakter). */
export function formatActivationCode(input: string): string {
  const raw = input.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 25);
  return raw.match(/.{1,5}/g)?.join('-') ?? '';
}

/**
 * Lisanssız kurulumda her yerin yerine gösterilen sayfa (Yönlendirici kurulmadan önce; `LicenseGate`).
 * Kimlik gerekmez: henüz kullanıcı yoktur. Etkinleşince genel yapılandırma tazelenir ve giriş/kayıt ekranı açılır.
 */
export function ActivationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['public-config'] });
  };

  const submit = async () => {
    setError(null);
    if (code.replace(/-/g, '').length !== 25) {
      setError(t('license.activation.invalidShape'));
      return;
    }
    setBusy(true);
    try {
      await api('/api/license/activate', { method: 'POST', body: { code } });
      await done();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('license.activation.title')} subtitle={t('license.activation.subtitle')} footer={t('license.activation.footer')}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('license.activation.codeLabel')} hint={t('license.activation.codeHint')} required>
          {(id) => (
            <Input
              id={id}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              placeholder={t('license.activation.codePlaceholder')}
              className="font-mono tracking-wider"
              value={code}
              onChange={(e) => setCode(formatActivationCode(e.target.value))}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          {t('license.activation.submit')}
        </Button>
      </form>

      <details className="mt-6 rounded-xl border border-border px-4 py-3 text-sm">
        <summary className="cursor-pointer select-none">{t('license.offline.title')}</summary>
        <div className="mt-4">
          <OfflineActivation onActivated={done} />
        </div>
      </details>
      <details className="mt-3 rounded-xl border border-border px-4 py-3 text-sm">
        <summary className="cursor-pointer select-none">{t('license.sentTitle')}</summary>
        <p className="mt-3 text-muted">{t('license.sentBody')}</p>
      </details>
    </AuthLayout>
  );
}
