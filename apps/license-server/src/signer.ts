import { readFileSync } from 'node:fs';
import { generateKeyPair, loadPrivateKey, openSigningKey, type SealedKeyFile, type Signer } from '@erp/license-core';
import type { Config } from './config';

/** Mühürlü anahtar dosyasını açar (parola yanlışsa ya da dosya bozuksa açıkça hata verir). */
export function loadSigner(config: Pick<Config, 'LICENSE_SIGNING_KEY_FILE' | 'LICENSE_SIGNING_KEY_PASSPHRASE'>): Signer & { publicKey: string } {
  if (!config.LICENSE_SIGNING_KEY_FILE || !config.LICENSE_SIGNING_KEY_PASSPHRASE) {
    throw new Error('İmza anahtarı yapılandırılmamış (LICENSE_SIGNING_KEY_FILE / LICENSE_SIGNING_KEY_PASSPHRASE)');
  }
  const file = JSON.parse(readFileSync(config.LICENSE_SIGNING_KEY_FILE, 'utf8')) as SealedKeyFile;
  return openSigningKey(file, config.LICENSE_SIGNING_KEY_PASSPHRASE);
}

/** Yalnızca testler/geliştirme: bellekte geçici imza anahtarı. */
export function ephemeralSigner(kid = 'k-dev'): Signer & { publicKey: string } {
  const pair = generateKeyPair();
  return { kid, privateKey: loadPrivateKey(pair.privateKeyPem), publicKey: pair.publicKey };
}
