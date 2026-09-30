import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

/** Yöneticinin belirlediği geçici parolayla ilk girişte: kullanıcı kendi parolasını seçmeden başka ekran açılmaz. */
export function PasswordChangeRequiredPage() {
  const { t } = useTranslation();
  const { reload, logout } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      await reload();
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.mustChangeTitle')}
      subtitle={t('auth.mustChangeSubtitle')}
      footer={
        <button type="button" className="link" onClick={() => void logout().then(() => navigate('/login'))}>
          {t('shell.logout')}
        </button>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next.length >= 10) void submit();
        }}
      >
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('auth.currentPassword')}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 10} className="mt-2 w-full">
          {t('common.save')}
        </Button>
      </form>
    </AuthLayout>
  );
}
