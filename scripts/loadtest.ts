/**
 * Çalışan bir API'ye karşı bağımlılıksız yük ölçümü (fetch havuzu). Her senaryo belirli süre, sabit eşzamanlılıkla
 * koşar; p50/p95/p99 gecikme, istek/sn ve hata oranı yazdırılır.
 *
 *   LOAD_BASE_URL=http://localhost:3000 LOAD_EMAIL=... LOAD_PASSWORD=... LOAD_COMPANY_ID=... npm run load:test
 * İsteğe bağlı: LOAD_CONCURRENCY=8 LOAD_SECONDS=8 LOAD_ONLY=trial-balance,party-list LOAD_JSON=/yol/sonuc.json
 * Not: sunucu RATE_LIMIT_ENABLED=false ile başlatılmalıdır (giriş ve dışa aktarma sınırları ölçümü keser).
 */
import { writeFileSync } from 'node:fs';

const base = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const conc = Number(process.env.LOAD_CONCURRENCY ?? 8);
const seconds = Number(process.env.LOAD_SECONDS ?? 8);
const only = process.env.LOAD_ONLY?.split(',').filter(Boolean);
const year = new Date().getUTCFullYear();

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.LOAD_EMAIL, password: process.env.LOAD_PASSWORD }),
});
if (!login.ok) throw new Error(`giriş başarısız: ${login.status} ${await login.text()}`);
const token = ((await login.json()) as { accessToken: string }).accessToken;
const companyId = process.env.LOAD_COMPANY_ID!;
const headers = { authorization: `Bearer ${token}`, 'x-company-id': companyId };
const get = (path: string) => fetch(`${base}${path}`, { headers });

// Örnek kimlikleri bir kez çek (cari, hesap)
const parties = (await (await get('/api/parties?limit=50')).json()) as { parties: { id: string }[]; total: number };
const partyId = parties.parties[0]!.id;
const accounts = ((await (await get('/api/accounts')).json()) as { accounts: { id: string; code: string }[] }).accounts;
const cash = accounts.find((a) => a.code === '100')!.id;
const range = `from=${year}-01-01&to=${year}-12-31`;

const scenarios: { name: string; path: string }[] = [
  { name: 'navigation', path: '/api/navigation' },
  { name: 'party-list', path: '/api/parties?limit=50' },
  { name: 'party-search', path: '/api/parties?limit=50&query=metal' },
  { name: 'party-aging', path: `/api/reports/party-aging?asOf=${year}-12-31` },
  { name: 'party-statement', path: `/api/parties/${partyId}/statement?${range}` },
  { name: 'journal-list', path: '/api/journal-entries?limit=50' },
  { name: 'trial-balance', path: `/api/reports/trial-balance?${range}` },
  { name: 'account-ledger', path: `/api/reports/account-ledger?accountId=${cash}&${range}` },
  { name: 'invoice-list', path: '/api/invoices?side=sales&limit=50' },
  { name: 'stock-status', path: `/api/reports/stock-status?asOf=${year}-12-31` },
  { name: 'vat-summary', path: `/api/reports/vat-summary?${range}` },
  { name: 'export-journal-book-csv', path: `/api/exports/journal-book?${range}&format=csv` },
];

interface Result { name: string; requests: number; rps: number; p50: number; p95: number; p99: number; errors: number; sampleStatus: number }
const results: Result[] = [];
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))]!;

for (const s of scenarios) {
  if (only && !only.includes(s.name)) continue;
  const first = await get(s.path);
  await first.arrayBuffer();
  const lat: number[] = [];
  let errors = 0;
  const end = Date.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < end) {
        const t = performance.now();
        try {
          const res = await get(s.path);
          await res.arrayBuffer();
          if (!res.ok) errors++;
        } catch {
          errors++;
        }
        lat.push(performance.now() - t);
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const r = { name: s.name, requests: lat.length, rps: +(lat.length / seconds).toFixed(1), p50: +q(lat, 0.5).toFixed(0), p95: +q(lat, 0.95).toFixed(0), p99: +q(lat, 0.99).toFixed(0), errors, sampleStatus: first.status };
  results.push(r);
  console.log(`${r.name.padEnd(26)} ${String(r.rps).padStart(7)} istek/sn  p50 ${String(r.p50).padStart(5)} ms  p95 ${String(r.p95).padStart(5)} ms  p99 ${String(r.p99).padStart(5)} ms  hata ${r.errors}  (ilk yanıt ${r.sampleStatus})`);
}
console.log(`\nVeri: ${parties.total} cari · eşzamanlılık ${conc} · ${seconds} sn/senaryo`);
if (process.env.LOAD_JSON) writeFileSync(process.env.LOAD_JSON, JSON.stringify({ conc, seconds, parties: parties.total, results }, null, 2));
