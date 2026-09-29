import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { z } from 'zod';
import { registerSchema, type RegisterInput } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

type FormInput = z.input<typeof registerSchema>;

export function RegisterPage() {
  const { t } = useTranslation();
  const { register: signUp } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, RegisterInput>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await signUp(values);
      navigate('/company/new', { replace: true });
    } catch (e) {
      const fe = fieldErrors(e);
      for (const [path, message] of Object.entries(fe)) {
        if (path in values) setFieldError(path as keyof FormInput, { message });
      }
      setError(errorMessage(e));
    }
  });

  return (
    <AuthLayout
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-brand hover:underline">
            {t('auth.login')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('auth.fullName')} error={errors.fullName?.message} required>
          {(id) => <Input id={id} autoComplete="name" autoFocus {...register('fullName')} />}
        </Field>
        <Field label={t('auth.organizationName')} error={errors.organizationName?.message} required>
          {(id) => <Input id={id} autoComplete="organization" {...register('organizationName')} />}
        </Field>
        <Field label={t('auth.email')} error={errors.email?.message} required>
          {(id) => <Input id={id} type="email" autoComplete="username" {...register('email')} />}
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')} error={errors.password?.message} required>
          {(id) => <Input id={id} type="password" autoComplete="new-password" {...register('password')} />}
        </Field>
        <Button type="submit" variant="primary" loading={isSubmitting} className="mt-2 w-full">
          {t('auth.register')}
        </Button>
      </form>
    </AuthLayout>
  );
}
