// Derleme sonrası ön sıkıştırma: dist içindeki metin varlıkları için .br ve .gz kopyaları üretir.
// API (@fastify/static preCompressed) tarayıcının kabul ettiği kopyayı doğrudan sunar; Caddy'siz masaüstü kurulumda
// ilk yük birkaç kat küçülür. Kaynak harita (.map) dosyaları sıkıştırılmaz.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../dist/', import.meta.url);
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml)$/i;
let files = 0;
let before = 0;
let after = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (TEXT.test(name) && statSync(path).size >= 1024) {
      const data = readFileSync(path);
      const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
      writeFileSync(`${path}.br`, br);
      writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
      files++;
      before += data.length;
      after += br.length;
    }
  }
}

walk(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
console.log(`ön sıkıştırma: ${files} dosya, ${(before / 1024).toFixed(0)} KB → brotli ${(after / 1024).toFixed(0)} KB`);
