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
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

const schema = z.object({ email: z.email('Geçerli bir e-posta girin'), password: z.string().min(1, 'Şifre gerekli') });
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await login({ email: values.email, password: values.password });
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="link">
            {t('auth.register')}
          </Link>
        </>
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
        <Button type="submit" variant="primary" loading={isSubmitting} className="mt-2 w-full">
          {t('auth.login')}
        </Button>
      </form>
    </AuthLayout>
  );
}
