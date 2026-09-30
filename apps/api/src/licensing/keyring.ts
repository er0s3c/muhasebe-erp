import { z } from 'zod';
import { publicKeyFromRaw, type PublicKeyring } from '@erp/license-core';

const keyringSchema = z.object({
  keys: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string().length(43)),
  revoked: z.array(z.string()).default([]),
});

/**
 * Satıcının açık anahtar halkasını (kid -> ham Ed25519 açık anahtarı) doğrulayıp çözer.
 * Biçim ya da anahtar bozuksa HATA verir (sessizce boş halka döndürmez).
 */
export function parseKeyring(json: string): PublicKeyring {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Açık anahtar halkası geçerli bir JSON değil');
  }
  const parsed = keyringSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Açık anahtar halkası geçersiz: ${z.prettifyError(parsed.error)}`);
  for (const [kid, key] of Object.entries(parsed.data.keys)) {
    try {
      publicKeyFromRaw(key);
    } catch {
      throw new Error(`Açık anahtar '${kid}' geçersiz (32 baytlık Ed25519 anahtarı, base64url olmalı)`);
    }
  }
  return { keys: parsed.data.keys, revoked: parsed.data.revoked };
}

/** Halkada güvenilir (iptal edilmemiş) en az bir anahtar var mı? */
export const keyringUsable = (ring: PublicKeyring): boolean => Object.keys(ring.keys).some((kid) => !ring.revoked?.includes(kid));
