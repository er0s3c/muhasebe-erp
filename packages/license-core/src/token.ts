import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, verify, type KeyObject } from 'node:crypto';

/**
 * İmzalı belirteçler (Ed25519, Node `crypto`; dış bağımlılık yok).
 *
 *  - Satıcı imzası (kira): `erp1.<kid>.<yükB64>.<imzaB64>`; imza `erp-license-v1|<tür>|<kid>|<yükB64>` üzerinedir.
 *    Tür imzaya girdiği için bir "kira" asla "çevrimdışı kira" ya da başka bir türmüş gibi sunulamaz.
 *  - Kurulum imzası (istekler): `{ p: yükB64, s: imzaB64 }`; imza `erp-license-v1|<tür>|-|<yükB64>` üzerinedir ve
 *    etkinleştirmede satıcıya bildirilen (sabitlenen) kurulum açık anahtarıyla doğrulanır.
 */
export type TokenKind = 'lease' | 'offline-lease' | 'release';
export type EnvelopeKind = 'activate' | 'heartbeat' | 'deactivate' | 'offline-request';

export type TokenErrorCode = 'MALFORMED' | 'UNKNOWN_KID' | 'REVOKED_KID' | 'BAD_SIGNATURE' | 'BAD_PAYLOAD';

export class LicenseTokenError extends Error {
  constructor(
    public readonly code: TokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LicenseTokenError';
  }
}

/** Uygulamaya gömülü açık anahtarlar: `kid` -> ham (32 bayt) açık anahtar, base64url. */
export interface PublicKeyring {
  keys: Record<string, string>;
  /** İptal edilmiş (artık güvenilmeyen) anahtar kimlikleri. */
  revoked?: readonly string[];
}

const PREFIX = 'erp1';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Ed25519 açık anahtarının SPKI DER öneki; ardından 32 bayt ham anahtar gelir. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const signingInput = (kind: string, kid: string, payloadB64: string) => Buffer.from(`erp-license-v1|${kind}|${kid}|${payloadB64}`, 'utf8');

const SIGNATURE_BYTES = 64;

/** İmza Ed25519 olduğundan tam 64 bayt olmalıdır; kırpılmış/uzatılmış imza, kodlaması kanonik olsa bile biçim hatasıdır. */
function decodeSignature(value: string): Buffer {
  const sig = decodeB64u(value);
  if (sig.length !== SIGNATURE_BYTES) throw new LicenseTokenError('MALFORMED', 'İmza uzunluğu geçersiz');
  return sig;
}

/** Sıkı base64url çözümü: kanonik olmayan (fazladan/geçersiz karakterli) girdiyi reddeder. */
function decodeB64u(value: string): Buffer {
  const buf = Buffer.from(value, 'base64url');
  if (buf.toString('base64url') !== value) throw new LicenseTokenError('MALFORMED', 'Geçersiz kodlama');
  return buf;
}

export function publicKeyFromRaw(raw: string): KeyObject {
  const bytes = decodeB64u(raw);
  if (bytes.length !== 32) throw new LicenseTokenError('MALFORMED', 'Açık anahtar 32 bayt olmalı');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

export function publicKeyToRaw(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

export interface GeneratedKey {
  /** Ham açık anahtar (base64url). */
  publicKey: string;
  /** Şifresiz PKCS#8 PEM (kurulum anahtarı için DB'de; satıcı anahtarı için `sealSigningKey` ile mühürlenir). */
  privateKeyPem: string;
}

export function generateKeyPair(): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKeyToRaw(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export const loadPrivateKey = (pem: string): KeyObject => createPrivateKey({ key: pem, format: 'pem' });

/** PEM'den ham açık anahtarı türetir. */
export const publicKeyOfPrivate = (privateKeyPem: string): string => publicKeyToRaw(createPublicKey(loadPrivateKey(privateKeyPem)));

// ---- Satıcı imzalı belirteç (kira) ------------------------------------------------------------------------

export interface Signer {
  kid: string;
  privateKey: KeyObject;
}

export function signToken(kind: TokenKind, payload: unknown, signer: Signer): string {
  if (!KID_RE.test(signer.kid)) throw new Error('Geçersiz anahtar kimliği');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(null, signingInput(kind, signer.kid, payloadB64), signer.privateKey);
  return `${PREFIX}.${signer.kid}.${payloadB64}.${sig.toString('base64url')}`;
}

/** İmzayı ve anahtar kimliğini doğrular; yükü (henüz şema doğrulaması yapılmamış) döndürür. */
export function verifyToken(kind: TokenKind, token: string, ring: PublicKeyring): unknown {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new LicenseTokenError('MALFORMED', 'Belirteç biçimi geçersiz');
  const [, kid, payloadB64, sigB64] = parts as [string, string, string, string];
  if (!KID_RE.test(kid)) throw new LicenseTokenError('MALFORMED', 'Anahtar kimliği geçersiz');
  if (ring.revoked?.includes(kid)) throw new LicenseTokenError('REVOKED_KID', 'Bu anahtar artık güvenilir değil');
  const raw = Object.hasOwn(ring.keys, kid) ? ring.keys[kid] : undefined;
  if (!raw) throw new LicenseTokenError('UNKNOWN_KID', 'Bilinmeyen anahtar kimliği');
  const sig = decodeSignature(sigB64);
  decodeB64u(payloadB64);
  if (!verify(null, signingInput(kind, kid, payloadB64), publicKeyFromRaw(raw), sig)) {
    throw new LicenseTokenError('BAD_SIGNATURE', 'İmza doğrulanamadı');
  }
  return parsePayload(payloadB64);
}

function parsePayload(payloadB64: string): unknown {
  try {
    return JSON.parse(decodeB64u(payloadB64).toString('utf8'));
  } catch (err) {
    if (err instanceof LicenseTokenError) throw err;
    throw new LicenseTokenError('BAD_PAYLOAD', 'Yük çözülemedi');
  }
}

// ---- Kurulum imzalı zarf (istekler) -----------------------------------------------------------------------

export interface Envelope {
  p: string;
  s: string;
}

export function signEnvelope(kind: EnvelopeKind, payload: unknown, privateKey: KeyObject): Envelope {
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { p, s: sign(null, signingInput(kind, '-', p), privateKey).toString('base64url') };
}

/** İmzayı DOĞRULAMADAN yükü okur (hangi kuruluma ait olduğunu bulmak için); güvenmeden önce `verifyEnvelope` şarttır. */
export function peekEnvelope(env: Envelope): unknown {
  return parsePayload(env.p);
}

export function verifyEnvelope(kind: EnvelopeKind, env: Envelope, publicKeyRaw: string): unknown {
  const sig = decodeSignature(env.s);
  decodeB64u(env.p);
  if (!verify(null, signingInput(kind, '-', env.p), publicKeyFromRaw(publicKeyRaw), sig)) {
    throw new LicenseTokenError('BAD_SIGNATURE', 'İmza doğrulanamadı');
  }
  return parsePayload(env.p);
}

/** Çevrimdışı etkinleştirme istek kodu: `erpreq1.<p>.<s>.<açık anahtar>` (imza, açık anahtarın sahipliğini kanıtlar). */
export function encodeRequestCode(payload: unknown, privateKeyPem: string): string {
  const priv = loadPrivateKey(privateKeyPem);
  const env = signEnvelope('offline-request', payload, priv);
  return `erpreq1.${env.p}.${env.s}.${publicKeyOfPrivate(privateKeyPem)}`;
}

export function decodeRequestCode(code: string): { payload: unknown; publicKey: string } {
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'erpreq1') throw new LicenseTokenError('MALFORMED', 'İstek kodu biçimi geçersiz');
  const [, p, s, publicKey] = parts as [string, string, string, string];
  return { payload: verifyEnvelope('offline-request', { p, s }, publicKey), publicKey };
}

// ---- Satıcı imza anahtarının diskte mühürlenmesi -----------------------------------------------------------

export interface SealedKeyFile {
  v: 1;
  kid: string;
  publicKey: string;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

// N=2^15, r=8: ~32 MB bellek; Node varsayılan üst sınırı (32 MB) sınırda kaldığı için açıkça yükseltilir.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

/** Özel anahtarı parola ile mühürler (scrypt + AES-256-GCM). `kid` ve açık anahtar ek doğrulanmış veridir. */
export function sealSigningKey(kid: string, key: GeneratedKey, passphrase: string): SealedKeyFile {
  if (passphrase.length < 12) throw new Error('Parola en az 12 karakter olmalı');
  if (!KID_RE.test(kid)) throw new Error('Geçersiz anahtar kimliği');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, SCRYPT), iv);
  cipher.setAAD(Buffer.from(`${kid}|${key.publicKey}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(key.privateKeyPem, 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid,
    publicKey: key.publicKey,
    kdf: 'scrypt',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function openSigningKey(file: SealedKeyFile, passphrase: string): Signer & { publicKey: string } {
  if (file.v !== 1 || file.kdf !== 'scrypt') throw new Error('Desteklenmeyen anahtar dosyası sürümü');
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, decodeB64u(file.salt), 32, SCRYPT), decodeB64u(file.iv));
    decipher.setAAD(Buffer.from(`${file.kid}|${file.publicKey}`, 'utf8'));
    decipher.setAuthTag(decodeB64u(file.tag));
    const pem = Buffer.concat([decipher.update(decodeB64u(file.ciphertext)), decipher.final()]).toString('utf8');
    const privateKey = loadPrivateKey(pem);
    if (publicKeyToRaw(createPublicKey(privateKey)) !== file.publicKey) throw new Error('Açık anahtar uyuşmuyor');
    return { kid: file.kid, privateKey, publicKey: file.publicKey };
  } catch {
    throw new Error('İmza anahtarı açılamadı (parola yanlış ya da dosya bozuk)');
  }
}
