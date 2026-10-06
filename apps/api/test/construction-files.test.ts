import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { backupFiles, restoreFiles } from '../../../installer/tools/construction-files.mjs';
describe('Özel çizim/model deposu yedeği', () => {
  it('dosya ve iş çıktısı korunur, tekrar yükleme güvenlidir, bozulma reddedilir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erp-files-')),
      source = join(dir, 'source'),
      target = join(dir, 'restored'),
      company = randomUUID(),
      bytes = Buffer.from('synthetic drawing'),
      hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(join(source, company), { recursive: true });
    await writeFile(join(source, company, hash), bytes);
    const archive = join(dir, 'backup.files.gz');
    expect(await backupFiles(source, archive)).toEqual({ count: 1 });
    expect(await restoreFiles(target, archive)).toEqual({ count: 1 });
    expect(await readFile(join(target, company, hash))).toEqual(bytes);
    expect(await restoreFiles(target, archive)).toEqual({ count: 1 });
    await writeFile(join(target, company, hash), 'corrupted');
    await expect(restoreFiles(target, archive)).rejects.toThrow('üzerine yazılmadı');
    await writeFile(archive + '.sha256', 'bad');
    await expect(restoreFiles(join(dir, 'new'), archive)).rejects.toThrow('SHA-256');
  });
  it('arşiv içinden dizin dışına yazma girişimini reddeder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erp-files-path-')),
      archive = join(dir, 'unsafe.gz'),
      bytes = gzipSync(
        Buffer.from(
          JSON.stringify({ format: 'erp-construction-files-v1' }) +
            '\n' +
            JSON.stringify({
              company: '../../escape',
              hash: 'a'.repeat(64),
              size: 1,
              base64: 'YQ==',
            }) +
            '\n',
        ),
      );
    await writeFile(archive, bytes);
    await writeFile(archive + '.sha256', createHash('sha256').update(bytes).digest('hex'));
    await expect(restoreFiles(join(dir, 'target'), archive)).rejects.toThrow('Geçersiz arşiv');
  });
});
