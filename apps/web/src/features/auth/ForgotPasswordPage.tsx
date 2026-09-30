import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { usePublicConfig } from '../../lib/queries';
import { AuthLayout } from './AuthLayout';

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const publicConfig = usePublicConfig();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.forgotTitle')}
      subtitle={t('auth.forgotSubtitle')}
      footer={
        <Link to="/login" className="link">
          {t('auth.backToLogin')}
        </Link>
      }
    >
      {publicConfig.data?.mailEnabled === false ? (
        <Callout tone="info">{t('auth.mailDisabledHint')}</Callout>
      ) : sent ? (
        <Callout tone="info" title={t('auth.forgotSentTitle')}>
          {t('auth.forgotSentBody')}
        </Callout>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (email.includes('@')) void submit();
          }}
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('auth.email')}>
            {(id) => <Input id={id} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email.includes('@')} className="mt-2 w-full">
            {t('auth.sendResetLink')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
