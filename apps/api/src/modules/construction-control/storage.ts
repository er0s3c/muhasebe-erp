import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { badRequest } from '../../http/errors';

function path(root: string, companyId: string, hash: string) {
  if (!/^[a-f0-9-]{36}$/.test(companyId) || !/^[a-f0-9]{64}$/.test(hash))
    throw badRequest('Geçersiz dosya anahtarı.');
  return join(resolve(root), companyId, hash);
}
export function validateAsset(data: Buffer, mime: string) {
  if (data.length < 1 || data.length > 25 * 1024 * 1024)
    throw badRequest('Dosya 25 MB sınırını aşıyor veya boş.');
  const valid =
    mime === 'application/pdf'
      ? data.subarray(0, 5).toString() === '%PDF-'
      : mime === 'image/png'
        ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? data[0] === 255 && data[1] === 216 && data[2] === 255
          : mime === 'application/x-step'
            ? data.subarray(0, 256).toString().trimStart().startsWith('ISO-10303-21;')
            : false;
  if (!valid) throw badRequest('Dosya içeriği seçilen biçimle uyuşmuyor.');
}
export async function storeAsset(root: string, companyId: string, data: Buffer) {
  const hash = createHash('sha256').update(data).digest('hex');
  const dest = path(root, companyId, hash);
  await mkdir(resolve(root, companyId), { recursive: true, mode: 0o700 });
  try {
    await writeFile(dest, data, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return hash;
}
export async function readAsset(root: string, companyId: string, hash: string) {
  const data = await readFile(path(root, companyId, hash));
  if (createHash('sha256').update(data).digest('hex') !== hash)
    throw new Error('Dosya bütünlüğü doğrulanamadı.');
  return data;
}
