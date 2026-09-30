import { describe, expect, it } from 'vitest';
import {
  LicenseTokenError,
  decodeRequestCode,
  encodeRequestCode,
  generateKeyPair,
  loadPrivateKey,
  openSigningKey,
  parseLeaseToken,
  peekEnvelope,
  sealSigningKey,
  signEnvelope,
  signToken,
  verifyEnvelope,
  verifyToken,
} from '../src';
import { makeLease, makeVendor, tokenOf } from './helpers';

const fails = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LicenseTokenError);
    expect((e as LicenseTokenError).code).toBe(code);
    return;
  }
  throw new Error(`Hata bekleniyordu (${code})`);
};

describe('satıcı imzalı belirteç (kira)', () => {
  it('imzalanır ve doğrulanır; yük aynen döner', () => {
    const { signer, ring } = makeVendor();
    const lease = makeLease();
    expect(parseLeaseToken(tokenOf(lease, signer), ring)).toEqual(lease);
  });

  it('yükü bir bit değiştirilmiş belirteç reddedilir (sektör/cihaz sayısı/süre değiştirilemez)', () => {
    const { signer, ring } = makeVendor();
    const token = tokenOf(makeLease(), signer);
    const [p, kid, payload, sig] = token.split('.') as [string, string, string, string];
    const tampered = JSON.parse(Buffer.from(payload, 'base64url').toString());
    tampered.sectors = ['CONSTRUCTION'];
    tampered.deviceLimit = 9999;
    const forged = [p, kid, Buffer.from(JSON.stringify(tampered)).toString('base64url'), sig].join('.');
    fails(() => parseLeaseToken(forged, ring), 'BAD_SIGNATURE');
  });

  it('başka bir anahtarla imzalanmış belirteç reddedilir', () => {
    const attacker = makeVendor('k-test');
    const { ring } = makeVendor('k-test');
    fails(() => parseLeaseToken(tokenOf(makeLease(), attacker.signer), ring), 'BAD_SIGNATURE');
  });

  it('bilinmeyen ve iptal edilmiş anahtar kimliği reddedilir; Object.prototype anahtarları çalışmaz', () => {
    const { signer, ring } = makeVendor('k-old');
    const token = tokenOf(makeLease(), signer);
    fails(() => parseLeaseToken(token, { keys: {} }), 'UNKNOWN_KID');
    fails(() => parseLeaseToken(token, { ...ring, revoked: ['k-old'] }), 'REVOKED_KID');
    const proto = makeVendor('__proto__');
    fails(() => parseLeaseToken(tokenOf(makeLease(), proto.signer), { keys: {} }), 'UNKNOWN_KID');
  });

  it('kırpılmış, fazladan parçalı ve kanonik olmayan kodlamalı belirteçler reddedilir', () => {
    const { signer, ring } = makeVendor();
    const token = tokenOf(makeLease(), signer);
    fails(() => parseLeaseToken(token.slice(0, -4), ring), 'MALFORMED');
    fails(() => parseLeaseToken(`${token}.x`, ring), 'MALFORMED');
    fails(() => parseLeaseToken(token.replace('erp1', 'erp2'), ring), 'MALFORMED');
    fails(() => parseLeaseToken(token + '=', ring), 'MALFORMED');
    fails(() => parseLeaseToken('', ring), 'MALFORMED');
  });

  it('alan ayrımı: çevrimdışı kira çevrimiçi kira olarak sunulamaz ve tersi; yükteki tür imzadakiyle uyuşmalı', () => {
    const { signer, ring } = makeVendor();
    const offline = makeLease({ typ: 'offline-lease' });
    expect(parseLeaseToken(tokenOf(offline, signer), ring).typ).toBe('offline-lease');
    // Yük 'lease' diyor ama 'offline-lease' olarak imzalanmış → tür uyuşmazlığı
    fails(() => parseLeaseToken(signToken('offline-lease', makeLease({ typ: 'lease' }), signer), ring), 'BAD_PAYLOAD');
    // Kira imzası, doğrulayıcı başka bir türle denerse geçmez
    fails(() => verifyToken('offline-lease', tokenOf(makeLease(), signer), ring), 'BAD_SIGNATURE');
  });

  it('şemaya uymayan yük reddedilir (sektörsüz, negatif cihaz, bozuk parmak izi)', () => {
    const { signer, ring } = makeVendor();
    fails(() => parseLeaseToken(signToken('lease', { ...makeLease(), sectors: [] }, signer), ring), 'BAD_PAYLOAD');
    fails(() => parseLeaseToken(signToken('lease', { ...makeLease(), deviceLimit: 0 }, signer), ring), 'BAD_PAYLOAD');
    fails(() => parseLeaseToken(signToken('lease', { ...makeLease(), fingerprint: 'zz' }, signer), ring), 'BAD_PAYLOAD');
  });
});

describe('kurulum imzalı zarf ve çevrimdışı istek kodu', () => {
  it('zarf doğru açık anahtarla doğrulanır; başka anahtar ve başka tür reddedilir', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const env = signEnvelope('heartbeat', { hello: 'dünya' }, loadPrivateKey(a.privateKeyPem));
    expect(verifyEnvelope('heartbeat', env, a.publicKey)).toEqual({ hello: 'dünya' });
    expect(peekEnvelope(env)).toEqual({ hello: 'dünya' });
    fails(() => verifyEnvelope('heartbeat', env, b.publicKey), 'BAD_SIGNATURE');
    fails(() => verifyEnvelope('activate', env, a.publicKey), 'BAD_SIGNATURE');
    fails(() => verifyEnvelope('heartbeat', { ...env, p: Buffer.from('{"hello":"x"}').toString('base64url') }, a.publicKey), 'BAD_SIGNATURE');
  });

  it('istek kodu gidiş-dönüş yapar ve kurcalanınca reddedilir', () => {
    const k = generateKeyPair();
    const code = encodeRequestCode({ installationId: 'x', requestId: 'r'.repeat(20) }, k.privateKeyPem);
    const decoded = decodeRequestCode(code);
    expect(decoded.publicKey).toBe(k.publicKey);
    expect(decoded.payload).toEqual({ installationId: 'x', requestId: 'r'.repeat(20) });
    const parts = code.split('.');
    parts[1] = Buffer.from('{"installationId":"evil","requestId":"rrrrrrrrrrrrrrrrrrrr"}').toString('base64url');
    fails(() => decodeRequestCode(parts.join('.')), 'BAD_SIGNATURE');
    fails(() => decodeRequestCode('erpreq1.a.b'), 'MALFORMED');
  });
});

describe('satıcı imza anahtarının mühürlenmesi', () => {
  it('doğru parolayla açılır ve imzalayabilir; yanlış parola ve kurcalanmış dosya reddedilir', () => {
    const pair = generateKeyPair();
    const sealed = sealSigningKey('k-2026a', pair, 'uzun-bir-parola-123');
    expect(JSON.stringify(sealed)).not.toContain('PRIVATE KEY');
    const opened = openSigningKey(sealed, 'uzun-bir-parola-123');
    expect(opened.publicKey).toBe(pair.publicKey);
    const ring = { keys: { 'k-2026a': pair.publicKey } };
    expect(parseLeaseToken(signToken('lease', makeLease(), opened), ring).customer).toBe('Örnek Market Ltd.');
    expect(() => openSigningKey(sealed, 'yanlis-parola-1234')).toThrow(/açılamadı/);
    expect(() => openSigningKey({ ...sealed, kid: 'k-baska' }, 'uzun-bir-parola-123')).toThrow(/açılamadı/);
    expect(() => sealSigningKey('k1', pair, 'kisa')).toThrow(/12 karakter/);
  });
});
