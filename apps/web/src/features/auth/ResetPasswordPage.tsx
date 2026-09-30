import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useToast } from '../../components/ui/Toast';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const { status, logout } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: password } });
      toast.success(t('auth.resetDone'));
      // Sıfırlama tüm oturumları kapattı; açık oturum varsa yerel durumu temizleyip girişe götür.
      if (status === 'authenticated') await logout();
      navigate('/login', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.resetTitle')}
      subtitle={t('auth.resetSubtitle')}
      footer={
        <Link to="/login" className="link">
          {t('auth.backToLogin')}
        </Link>
      }
    >
      {token.length < 20 ? (
        <Callout tone="danger">{t('auth.linkInvalid')}</Callout>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length >= 10) void submit();
          }}
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={password.length < 10} className="mt-2 w-full">
            {t('auth.resetSubmit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
