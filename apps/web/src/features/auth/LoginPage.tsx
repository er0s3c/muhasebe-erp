import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { errorMessage } from '../../lib/errors';
import { usePublicConfig } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

const schema = z.object({ email: z.email('Geçerli bir e-posta girin'), password: z.string().min(1, 'Şifre gerekli') });
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { login, verifyMfa } = useSession();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const publicConfig = usePublicConfig();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const step = await login({ email: values.email, password: values.password });
      if (step) {
        setMfaToken(step.mfaToken);
        return;
      }
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const onVerify = async () => {
    if (!mfaToken || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(mfaToken, code.trim());
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <AuthLayout title={t('auth.mfa.title')} subtitle={t('auth.mfa.subtitle')} footer={null}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onVerify();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('auth.mfa.code')} hint={t('auth.mfa.hint')}>
            {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!code.trim()} className="mt-2 w-full">
            {t('auth.mfa.verify')}
          </Button>
          <button
            type="button"
            className="link self-start text-sm"
            onClick={() => {
              setMfaToken(null);
              setCode('');
              setError(null);
            }}
          >
            {t('auth.mfa.back')}
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        publicConfig.data?.registrationEnabled === false ? undefined : (
          <>
            {t('auth.noAccount')}{' '}
            <Link to="/register" className="link">
              {t('auth.register')}
            </Link>
          </>
        )
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('auth.email')} error={errors.email?.message}>
          {(id) => <Input id={id} type="email" autoComplete="username" autoFocus {...register('email')} />}
        </Field>
        <Field label={t('auth.password')} error={errors.password?.message}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" {...register('password')} />}
        </Field>
        {publicConfig.data?.mailEnabled && (
          <Link to="/forgot-password" className="link self-start text-sm">
            {t('auth.forgotLink')}
          </Link>
        )}
        <Button type="submit" variant="primary" loading={isSubmitting} className="mt-2 w-full">
          {t('auth.login')}
        </Button>
      </form>
    </AuthLayout>
  );
}
