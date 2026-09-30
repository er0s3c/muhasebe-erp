import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@ui/Button';
import { Callout } from '@ui/Feedback';
import { Field, Input } from '@ui/Field';
import { api, errorText } from '../api';
import { loginWithPasskey, passkeyErrorText, passkeysSupported } from '../passkey';

/**
 * Parola + zorunlu TOTP ya da giriş anahtarı (passkey; kullanıcı doğrulamalı, e-posta sorulmaz).
 * Hiç yönetici yoksa ilk kurulum sayfasına (/setup) yönlendirir.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needed: boolean }>('/admin/api/setup'), retry: false });

  const passkey = async () => {
    setPasskeyBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (setup.data?.needed) return <Navigate to="/setup" replace />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/api/login', { method: 'POST', body: { email, password, totp } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-heading">Lisans yönetimi</h1>
        <p className="mt-1.5 text-sm text-muted">Yönetici girişi: e-posta, parola ve kimlik doğrulama uygulamasındaki 6 haneli kod.</p>
        <form
          className="mt-7 flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label="E-posta">{(id) => <Input id={id} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Parola">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Field label="Doğrulama kodu">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="font-mono tracking-widest"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email || !password || totp.length !== 6}>
            Giriş yap
          </Button>
        </form>
        {passkeysSupported() && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-muted" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              ya da
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button className="w-full" loading={passkeyBusy} onClick={() => void passkey()}>
              <KeyRound className="size-4" aria-hidden /> Giriş anahtarıyla giriş
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
