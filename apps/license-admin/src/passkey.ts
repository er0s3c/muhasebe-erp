import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, errorText, type Passkey } from './api';

/** Giriş anahtarları (WebAuthn): tarayıcı ya da parola kasası eklentisi (Vaultwarden/Bitwarden) anahtarı üretir ve saklar. */
export const passkeysSupported = () => browserSupportsWebAuthn();

export async function addPasskey(name?: string): Promise<Passkey> {
  const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>('/admin/api/passkeys/options', { method: 'POST' });
  const response = await startRegistration({ optionsJSON: options });
  return (await api<{ passkey: Passkey }>('/admin/api/passkeys', { method: 'POST', body: { name: name?.trim() || undefined, response } })).passkey;
}

export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/admin/api/passkey/options', { method: 'POST', body: {} });
  const response = await startAuthentication({ optionsJSON: options });
  await api('/admin/api/passkey/login', { method: 'POST', body: { challengeId, response } });
}

export function passkeyErrorText(err: unknown): string {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'Bu giriş anahtarı zaten kayıtlı.';
    if (err.code === 'ERROR_INVALID_DOMAIN' || err.code === 'ERROR_INVALID_RP_ID') return 'Giriş anahtarı bu adreste kullanılamaz (HTTPS ve doğru alan adı gerekir).';
    if (err.code === 'ERROR_CEREMONY_ABORTED') return 'İşlem iptal edildi.';
  }
  if (err instanceof Error && err.name === 'NotAllowedError') return 'İşlem iptal edildi ya da süresi doldu.';
  return errorText(err);
}
