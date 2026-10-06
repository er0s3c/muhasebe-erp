/** Streaming, content-addressed companion archive. Never follows links or overwrites files. */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, readFile, writeFile, link, unlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve, join, dirname, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
const company = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  hash = /^[0-9a-f]{64}$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function regular(path, dir = false) {
  const s = await lstat(path);
  if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile()))
    throw new Error('Dosya deposunda bağlantı veya geçersiz nesne var.');
  return s;
}
function rootPath(root) {
  const p = resolve(root);
  if (p === parse(p).root) throw new Error('Dosya deposu disk kökü olamaz.');
  return p;
}
export async function backupFiles(root, archive) {
  root = rootPath(root);
  archive = resolve(archive);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await regular(root, true);
  await mkdir(dirname(archive), { recursive: true });
  const zip = createGzip(),
    stream = createWriteStream(archive + '.partial', { flags: 'wx', mode: 0o600 });
  const done = pipeline(zip, stream);
  void done.catch(()=>{});
  const line = async (value) => {
    if (!zip.write(JSON.stringify(value) + '\n')) await once(zip, 'drain');
  };
  let count = 0;
  try {
  await line({ format: 'erp-construction-files-v1' });
  for (const dir of await readdir(root)) {
    if (!company.test(dir)) continue;
    const folder = join(root, dir);
    await regular(folder, true);
    for (const name of await readdir(folder)) {
      if (!hash.test(name)) throw new Error('Dosya deposunda geçersiz anahtar.');
      const path = join(folder, name),
        stat = await regular(path);
      if (stat.size > 256 * 1024 * 1024) throw new Error('Tek dosya yedekleme sınırını aşıyor.');
      const bytes = await readFile(path);
      if (sha(bytes) !== name) throw new Error('Kaynak dosya bütünlüğü bozuk.');
      await line({
        company: dir,
        hash: name,
        size: bytes.length,
        base64: bytes.toString('base64'),
      });
      count++;
    }
  }
  zip.end();
  await done;
  await link(archive + '.partial', archive);
  await unlink(archive + '.partial');
  } catch(e) {zip.destroy();await done.catch(()=>{});try{await unlink(archive+'.partial');}catch{/* already removed */}throw e;}
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  await writeFile(archive + '.sha256', digest.digest('hex') + '\n', { mode: 0o600 });
  return { count };
}
async function records(archive, onRecord) {
  const stream = createReadStream(archive).pipe(createGunzip()),
    lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header = false,
    count = 0;
  let expanded=0;
  for await (const text of lines) {
    expanded+=Buffer.byteLength(text);
    if(expanded>1024*1024*1024 || count>100000) throw new Error('Açılan dosya yedeği güvenli boyut sınırını aşıyor.');
    const r = JSON.parse(text);
    if (!header) {
      if (r.format !== 'erp-construction-files-v1') throw new Error('Geçersiz dosya yedeği.');
      header = true;
      continue;
    }
    if (
      !company.test(r.company) ||
      !hash.test(r.hash) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 1 ||
      r.size > 256 * 1024 * 1024 ||
      typeof r.base64 !== 'string'
    )
      throw new Error('Geçersiz arşiv kaydı.');
    const bytes = Buffer.from(r.base64, 'base64');
    if (bytes.length !== r.size || sha(bytes) !== r.hash)
      throw new Error('Arşiv dosyasının bütünlüğü bozuk.');
    await onRecord(r, bytes);
    count++;
  }
  if (!header) throw new Error('Boş dosya yedeği.');
  return count;
}
export async function restoreFiles(root, archive) {
  root = rootPath(root);
  archive = resolve(archive);
  await regular(archive);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  const expected = (await readFile(archive + '.sha256', 'utf8')).trim();
  if (expected !== digest.digest('hex'))
    throw new Error('Dosya yedeğinin SHA-256 özeti uyuşmuyor.');
  await records(archive, async () => {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  await regular(root, true);
  const count = await records(archive, async (r, bytes) => {
    const folder = join(root, r.company);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await regular(folder, true);
    const path = join(folder, r.hash);
    try {
      await access(path);
      await regular(path);
      if (sha(await readFile(path)) !== r.hash)
        throw new Error('Hedefteki dosya bütünlüğü bozuk; üzerine yazılmadı.');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    }
  });
  return { count };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const i = a.indexOf('=');
      return [a.slice(2, i), a.slice(i + 1)];
    }),
  );
  if (!args.root || !args.archive || !['backup', 'restore'].includes(args.mode))
    throw new Error('--mode=backup|restore --root=DİZİN --archive=DOSYA gerekli');
  console.log(
    JSON.stringify(
      await (args.mode === 'backup' ? backupFiles : restoreFiles)(args.root, args.archive),
    ),
  );
}
