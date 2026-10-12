import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@ui/Button';
import { Brand } from '@ui/Brand';
import { Callout, ErrorState, PageLoading } from '@ui/Feedback';
import { Field, Input } from '@ui/Field';
import { useToast } from '@ui/Toast';
import { FormGuard } from '@ui/UnsavedChanges';
import { api, ApiError, errorText } from '../api';
import { QrCode } from '../components/QrCode';
import { addPasskey, passkeyErrorText, passkeysSupported } from '../passkey';

interface PendingTotp {
  secret: string;
  otpauthUri: string;
  pending: string;
}

const MIN_PASSWORD = 12;
const STEPS = ['Hesap', 'Doğrulama uygulaması', 'Giriş anahtarı'] as const;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* pano izni yok: değer seçilip elle kopyalanır */
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label={label}>
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Kopyalandı' : 'Kopyala'}
    </Button>
  );
}

/**
 * İlk yönetici kurulumu (yalnızca hiç yönetici yokken): kurulum kodu + e-posta + parola (iki kez) → TOTP sırrı (QR, anahtar,
 * otpauth adresi: Vaultwarden/Bitwarden'ın "Kimlik doğrulayıcı anahtarı" alanına yapıştırılabilir) → isteğe bağlı giriş anahtarı.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needed: boolean }>('/admin/api/setup'), retry: false });
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ setupToken: '', email: '', fullName: '', password: '', passwordConfirm: '' });
  const [totp, setTotp] = useState('');
  const [pending, setPending] = useState<PendingTotp | null>(null);
  const [passkeyName, setPasskeyName] = useState('Vaultwarden');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);

  if (status.isPending) return <PageLoading />;
  if (status.error) return <div className="mx-auto max-w-xl p-6"><ErrorState title="Kurulum durumu yüklenemedi" description={errorText(status.error)} onRetry={() => void status.refetch()} retrying={status.isFetching} /></div>;
  if (step === 0 && status.data && !status.data.needed) return <Navigate to="/login" replace />;

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.passwordConfirm.length > 0 && form.password !== form.passwordConfirm;
  const tooShort = form.password.length > 0 && form.password.length < MIN_PASSWORD;
  const accountValid = form.setupToken.trim() && form.email.includes('@') && form.password.length >= MIN_PASSWORD && form.password === form.passwordConfirm;

  const run = async (fn: () => Promise<void>) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'INVALID_SETUP_TOKEN') setStep(0);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  const beginTotp = () =>
    run(async () => {
      setPending(await api<PendingTotp>('/admin/api/setup/totp', { method: 'POST', body: { setupToken: form.setupToken, email: form.email.trim() } }));
      setTotp('');
      setStep(1);
    });

  const createAccount = () =>
    run(async () => {
      await api('/admin/api/setup', { method: 'POST', body: { ...form, fullName: form.fullName.trim() || undefined, pending: pending!.pending, totp } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.setQueryData(['setup'], { needed: false });
      setStep(2);
    });

  const registerPasskey = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await addPasskey(passkeyName);
      toast.success('Giriş anahtarı eklendi.');
      navigate('/', { replace: true });
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  return (
    <FormGuard captureAll dirty={step < 2 && Object.values(form).some((value) => value.length > 0)} pending={busy} className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <Brand className="mb-6 h-9" />
        <h1 className="text-heading">İlk kurulum</h1>
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Kurulum adımları">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined} className={i === step ? 'text-text' : 'text-muted'}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <form
            className="mt-6 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (accountValid) void beginTotp();
            }}
          >
            <p className="text-sm text-muted">Yönetici hesabınızı oluşturun. Parolayı Vaultwarden'a kaydedin; tarayıcı eklentisi kaydetmeyi önerir.</p>
            {error && <Callout tone="danger">{error}</Callout>}
            <Field label="Kurulum kodu" required hint="Sunucuda: docker compose … exec license node dist/cli.js setup:token">
              {(id) => <Input id={id} autoFocus autoComplete="off" spellCheck={false} className="font-mono tracking-wider" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" value={form.setupToken} onChange={set('setupToken')} />}
            </Field>
            <Field label="E-posta" required>
              {(id) => <Input id={id} type="email" autoComplete="username" value={form.email} onChange={set('email')} />}
            </Field>
            <Field label="Ad soyad">{(id) => <Input id={id} autoComplete="name" value={form.fullName} onChange={set('fullName')} />}</Field>
            <Field label="Parola" required error={tooShort ? `En az ${MIN_PASSWORD} karakter` : undefined} hint={`En az ${MIN_PASSWORD} karakter; kasanızın üreteciyle oluşturabilirsiniz.`}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />}
            </Field>
            <Field label="Parola (tekrar)" required error={mismatch ? 'Parolalar eşleşmiyor' : undefined}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.passwordConfirm} onChange={set('passwordConfirm')} />}
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!accountValid}>
              Devam
            </Button>
          </form>
        )}

        {step === 1 && pending && (
          <form
            className="mt-6 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (totp.length === 6) void createAccount();
            }}
          >
            {/* Parola yöneticileri doğrulama kodunu doğru kayda bağlayabilsin diye */}
            <input type="email" autoComplete="username" value={form.email} readOnly hidden />
            <p className="text-sm text-muted">
              Vaultwarden'da bu siteye ait kaydı açın ve <span className="text-text">Kimlik doğrulayıcı anahtarı (TOTP)</span> alanına aşağıdaki adresi ya da anahtarı yapıştırın.
              Bitwarden mobil uygulamasıyla QR kodunu da okutabilirsiniz; başka bir doğrulama uygulaması da olur.
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="flex justify-center">
              <QrCode value={pending.otpauthUri} label="Doğrulama uygulaması QR kodu" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px]">Anahtar</span>
                <CopyButton value={pending.secret} label="Anahtarı kopyala" />
              </div>
              <code data-testid="totp-secret" className="select-all break-all rounded-lg border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm tracking-wider">
                {pending.secret.match(/.{1,4}/g)!.join(' ')}
              </code>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px]">Vaultwarden için adres (otpauth)</span>
                <CopyButton value={pending.otpauthUri} label="otpauth adresini kopyala" />
              </div>
              <code data-testid="totp-uri" className="select-all break-all rounded-lg border border-border-strong bg-surface-2 px-3 py-2 font-mono text-xs">
                {pending.otpauthUri}
              </code>
            </div>
            <Field label="Doğrulama kodu" required hint="Kasada/uygulamada görünen 6 haneli kod.">
              {(id) => (
                <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="font-mono tracking-widest" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />
              )}
            </Field>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => setStep(0)}>Geri</Button>
              <Button type="submit" variant="primary" className="flex-1" loading={busy} disabled={totp.length !== 6}>
                Hesabı oluştur
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div className="mt-6 flex flex-col gap-5">
            <Callout tone="info" title="Hesap oluşturuldu">
              Artık e-posta, parola ve doğrulama koduyla giriş yapabilirsiniz.
            </Callout>
            <p className="text-sm text-muted">
              İsterseniz bir <span className="text-text">giriş anahtarı</span> (passkey) ekleyin: Vaultwarden eklentisi anahtarı saklar, sonraki girişler tek tıkla olur. Kasanın kilidi
              açık olmalıdır; anahtar parola ve kodun yerini tutar.
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
            {passkeysSupported() ? (
              <>
                <Field label="Anahtarın adı">{(id) => <Input id={id} maxLength={60} value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} />}</Field>
                <Button variant="primary" loading={busy} onClick={() => void registerPasskey()}>
                  <KeyRound className="size-4" aria-hidden /> Giriş anahtarı ekle
                </Button>
              </>
            ) : (
              <Callout tone="warning">Bu tarayıcı giriş anahtarlarını desteklemiyor.</Callout>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => navigate('/', { replace: true })}>
              Şimdilik geç, panele git
            </Button>
          </div>
        )}
      </div>
    </FormGuard>
  );
}
