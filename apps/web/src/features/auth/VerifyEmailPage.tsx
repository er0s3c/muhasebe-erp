import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Callout } from '../../components/ui/Feedback';
import { PageLoading } from '../../components/ui/Feedback';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export function VerifyEmailPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { status, reload } = useSession();
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token.length < 20 ? 'error' : 'working');
  const [error, setError] = useState<string | null>(token.length < 20 ? t('auth.linkInvalid') : null);
  const started = useRef(false);

  // Bağlantı tek kullanımlıktır: React'in çift çalıştırmasında ikinci istek "geçersiz" görünmesin diye bir kez gönderilir.
  useEffect(() => {
    if (token.length < 20 || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await api('/api/auth/verify-email', { method: 'POST', body: { token } });
        setState('ok');
        if (status === 'authenticated') await reload();
      } catch (e) {
        setError(errorMessage(e));
        setState('error');
      }
    })();
  }, [token, status, reload]);

  return (
    <AuthLayout
      title={t('auth.verifyTitle')}
      subtitle={t('auth.verifySubtitle')}
      footer={
        <Link to={status === 'authenticated' ? '/' : '/login'} className="link">
          {status === 'authenticated' ? t('nav.dashboard') : t('auth.backToLogin')}
        </Link>
      }
    >
      {state === 'working' && <PageLoading />}
      {state === 'ok' && <Callout tone="info" title={t('auth.verifiedTitle')}>{t('auth.verifiedBody')}</Callout>}
      {state === 'error' && <Callout tone="danger">{error}</Callout>}
    </AuthLayout>
  );
}
