import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * Testler için yazılım doğrulayıcısı (WebAuthn): P-256 anahtar, `none` onayı. Tarayıcının/kasanın (ör. Vaultwarden)
 * ürettiği yanıtın aynısını üretir; bayraklar (UV, BE/BS) ve köken testte değiştirilebilir.
 */
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest();

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

export interface SoftAuthenticator {
  credentialId: Buffer;
  privateKey: KeyObject;
  cosePublicKey: Uint8Array;
  userHandle?: string;
  counter: number;
}

export function makeAuthenticator(): SoftAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map<number, number | Uint8Array>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
  ]);
  return { credentialId: randomBytes(16), privateKey, cosePublicKey: isoCBOR.encode(cose), counter: 0 };
}

interface Opts {
  origin: string;
  rpId: string;
  uv?: boolean;
  synced?: boolean;
}

function flagsOf(o: Opts, extra = 0) {
  return UP | (o.uv === false ? 0 : UV) | (o.synced ? BE | BS : 0) | extra;
}

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function registrationResponse(a: SoftAuthenticator, options: { challenge: string; user: { id: string } }, o: Opts) {
  a.userHandle = options.user.id;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(a.credentialId.length);
  const authData = Buffer.concat([sha256(o.rpId), Buffer.from([flagsOf(o, AT)]), u32(a.counter), Buffer.alloc(16), idLen, a.credentialId, Buffer.from(a.cosePublicKey)]);
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin, crossOrigin: false }));
  return {
    id: b64u(a.credentialId),
    rawId: b64u(a.credentialId),
    type: 'public-key',
    response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    clientExtensionResults: {},
  };
}

export function authenticationResponse(a: SoftAuthenticator, options: { challenge: string }, o: Opts) {
  const authData = Buffer.concat([sha256(o.rpId), Buffer.from([flagsOf(o)]), u32(a.counter)]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin, crossOrigin: false }));
  const signature = createSign('sha256').update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(a.privateKey);
  return {
    id: b64u(a.credentialId),
    rawId: b64u(a.credentialId),
    type: 'public-key',
    response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: a.userHandle },
    clientExtensionResults: {},
  };
}
