/**
 * Geliştirme/demo verisi: örnek bir inşaat şirketi, kurlar, bir yıllık yevmiye kaydı.
 * Yalnızca geliştirme içindir; üretimde çalışmayı reddeder. Tekrar çalıştırılırsa
 * demo kullanıcı varsa hiçbir şey yapmaz.
 *
 *   npm run db:seed
 *   Giriş: demo@ornek.local / Demo-Sifre-123
 */
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { applyRate, isoYear, todayIso, toDbRate, type CreateJournalInput, type CreatePartyInput } from '@erp/shared';
import { loadConfig } from '../config';
import { createDb, withContext, type Tx } from './client';
import { customCodes, exchangeRates, memberships, organizations, users } from './schema';
import { createParty } from '../modules/parties/service';
import { createAccount, listAccounts } from '../modules/ledger/accounts';
import {
  createJournalEntry,
  reverseJournalEntry,
  type LedgerCtx,
} from '../modules/ledger/journal';
import { closePeriod, findPeriodForDate } from '../modules/settings/periods';
import { createCompany } from '../modules/tenancy/service';

const DEMO_EMAIL = 'demo@ornek.local';
const DEMO_PASSWORD = 'Demo-Sifre-123';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('Demo verisi üretimde yüklenemez.');
}

const handle = createDb(config.DATABASE_URL);
const { db } = handle;

const today = todayIso();
const year = isoYear(today);
const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const date = (m: number, d: number) => `${year}-${pad(m)}-${pad(d)}`;

/**
 * Yıl başından bugüne doğrusal seyreden kurlar (yalnızca demo). Bitiş değerleri, Merkez Bankası'nın
 * 29/09/2026 tarihli XML dosyasındaki Döviz Alış kurlarıdır; başlangıç değerleri uydurmadır.
 */
const RATE_TREND = {
  GBP: { start: 57.0, end: 64.7268 },
  EUR: { start: 49.0, end: 55.6307 },
  USD: { start: 43.0, end: 48.9008 },
} as const;
type Foreign = keyof typeof RATE_TREND;

function rateAt(cur: Foreign, iso: string): number {
  const t0 = Date.parse(`${year}-01-01T00:00:00Z`);
  const t1 = Date.parse(`${today}T00:00:00Z`);
  const t = t1 === t0 ? 1 : Math.min(1, Math.max(0, (Date.parse(`${iso}T00:00:00Z`) - t0) / (t1 - t0)));
  const { start, end } = RATE_TREND[cur];
  return Math.round((start + (end - start) * t) * 10000) / 10000;
}

async function seedRates(tx: Tx, companyId: string, userId: string) {
  const dates = new Set<string>();
  for (let m = 1; m <= 12; m++) for (const d of [1, 8, 15, 22, 28]) if (date(m, d) <= today) dates.add(date(m, d));
  for (let i = 0; i < 12; i++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    dates.add(d.toISOString().slice(0, 10));
  }
  const rows = [...dates].flatMap((d) =>
    (Object.keys(RATE_TREND) as Foreign[]).map((cur) => {
      const buy = rateAt(cur, d);
      return {
        companyId,
        rateDate: d,
        currencyCode: cur,
        quoteCode: 'TRY',
        buy: toDbRate(buy),
        sell: toDbRate(buy * 1.005),
        source: 'demo',
        createdBy: userId,
      };
    }),
  );
  await tx.insert(exchangeRates).values(rows).onConflictDoNothing();
}

type Side = 'debit' | 'credit';
interface Spec {
  on: string;
  text: string;
  lines: [code: string, side: Side, amount: string, opts?: { cur?: Foreign; desc?: string; party?: string; dueDays?: number }][];
  post?: boolean;
  reverseOn?: string;
}

async function main() {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL));
  if (existing) {
    console.log(`Demo verisi zaten var (${DEMO_EMAIL}). Sıfırdan yüklemek için veritabanını sıfırlayın.`);
    return;
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const { orgId, userId } = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Örnek Holding' }).returning({ id: organizations.id });
    const [u] = await tx
      .insert(users)
      .values({ organizationId: org!.id, email: DEMO_EMAIL, passwordHash, fullName: 'Ayşe Demir' })
      .returning({ id: users.id });
    return { orgId: org!.id, userId: u!.id };
  });

  await withContext(db, { userId, orgId }, async (tx) => {
    const company = await createCompany(
      tx,
      { id: userId, orgId },
      {
        name: 'Örnek İnşaat Ltd.',
        sector: 'CONSTRUCTION',
        baseCurrency: 'TRY',
        reportingCurrency: 'GBP',
        taxNumber: '1234567',
        taxOffice: 'Lefkoşa',
      },
    );
    const ctx: LedgerCtx = {
      companyId: company.id,
      userId,
      baseCurrency: 'TRY',
      reportingCurrency: 'GBP',
    };

    // Ekip: muhasebeci ve izleyici
    for (const [email, fullName, role] of [
      ['muhasebe@ornek.local', 'Mehmet Kaya', 'accountant'],
      ['izleyici@ornek.local', 'Elif Şahin', 'viewer'],
    ] as const) {
      const [m] = await tx
        .insert(users)
        .values({ organizationId: orgId, email, passwordHash, fullName })
        .returning({ id: users.id });
      await tx.insert(memberships).values({ companyId: company.id, userId: m!.id, role });
    }

    await seedRates(tx, company.id, userId);

    // Alt hesaplar (cari hesapları 120/320 üzerinde cari kartlarıyla tutulur)
    await createAccount(tx, company.id, { code: '102.001', name: 'KTB TL Vadesiz' });
    await createAccount(tx, company.id, { code: '102.002', name: 'KTB GBP Hesabı', currencyCode: 'GBP' });

    const byCode = new Map((await listAccounts(tx)).map((a) => [a.code, a.id]));
    const acc = (code: string) => {
      const id = byCode.get(code);
      if (!id) throw new Error(`Hesap yok: ${code}`);
      return id;
    };

    const partyDefs: Record<string, Partial<CreatePartyInput> & Pick<CreatePartyInput, 'name' | 'kind'>> = {
      ali: { name: 'Ali Yılmaz', kind: 'customer', phone: '0533 111 22 33', paymentTermDays: 30, notes: 'A Blok 3. kat daire alıcısı' },
      sarah: { name: 'Sarah Thompson', kind: 'customer', phone: '+44 7700 900123', email: 'sarah@example.com', paymentTermDays: 30, notes: 'B Blok 1. kat daire alıcısı' },
      demir: { name: 'Demir Çelik A.Ş.', kind: 'supplier', taxNumber: '7654321', taxOffice: 'Lefkoşa', phone: '0392 222 33 44', paymentTermDays: 60 },
      beton: { name: 'Hazır Beton Ltd.', kind: 'supplier', taxNumber: '7654322', taxOffice: 'Girne', paymentTermDays: 30 },
      oto: { name: 'Lefkoşa Otomotiv Ltd.', kind: 'supplier', taxNumber: '7654323', taxOffice: 'Lefkoşa', paymentTermDays: 30 },
      usta: { name: 'Mehmet Usta (kalıp taşeronu)', kind: 'both', phone: '0542 333 44 55' },
    };
    const partyId = new Map<string, string>();
    for (const [key, def] of Object.entries(partyDefs)) {
      const p = await createParty(tx, company.id, { currencyCode: 'TRY', paymentTermDays: 0, ...def });
      partyId.set(key, p.id);
    }

    await tx.insert(customCodes).values([
      { companyId: company.id, scope: 'account', code: 'ŞNT', name: 'Şantiye giderleri' },
      { companyId: company.id, scope: 'account', code: 'MRK', name: 'Merkez ofis giderleri' },
      { companyId: company.id, scope: 'transaction', code: 'AVN', name: 'Müşteri avansı' },
      { companyId: company.id, scope: 'party', code: 'TAŞ', name: 'Taşeron' },
    ]);

    // ---- Bir yıllık örnek hareketler --------------------------------------
    const specs: Spec[] = [
      { on: date(1, 5), text: 'Sermaye girişi', lines: [['102.001', 'debit', '2500000'], ['500', 'credit', '2500000']] },
      { on: date(1, 12), text: 'Arsa alımı (Girne, 2 dönüm)', lines: [['250', 'debit', '1800000'], ['102.001', 'credit', '1800000']] },
      {
        on: date(1, 20), text: 'İnşaat demiri alımı — Demir Çelik A.Ş.',
        lines: [['150', 'debit', '420000'], ['191', 'debit', '67200'], ['320', 'credit', '487200', { party: 'demir', dueDays: 60 }]],
      },
      { on: date(2, 3), text: 'Satıcıya ödeme — Demir Çelik A.Ş.', lines: [['320', 'debit', '300000', { party: 'demir' }], ['102.001', 'credit', '300000']] },
      {
        on: date(2, 14), text: 'Yurt dışı yatırımcıdan GBP avans',
        lines: [['102.002', 'debit', '50000', { cur: 'GBP' }], ['340', 'credit', '__GBP50000__']],
      },
      {
        on: date(3, 8), text: 'Daire satışı — A Blok 3. kat',
        lines: [['120', 'debit', '1160000', { party: 'ali', dueDays: 30 }], ['600', 'credit', '1000000'], ['391', 'credit', '160000']],
      },
      { on: date(3, 25), text: 'Daire satışı tahsilatı (ilk taksit)', lines: [['102.001', 'debit', '500000'], ['120', 'credit', '500000', { party: 'ali' }]] },
      {
        on: date(4, 4), text: 'Şantiye ofisi kirası',
        lines: [['770', 'debit', '45000'], ['191', 'debit', '7200'], ['102.001', 'credit', '52200']],
      },
      {
        on: date(4, 18), text: 'Şantiye aracı alımı',
        lines: [['254', 'debit', '850000'], ['191', 'debit', '136000'], ['320', 'credit', '986000', { party: 'oto', dueDays: 30 }]],
      },
      { on: date(5, 2), text: 'Nisan personel ödemeleri', lines: [['770', 'debit', '180000'], ['102.001', 'credit', '180000']] },
      {
        on: date(6, 10), text: 'Yurt dışı yatırımcıdan ikinci GBP avans',
        lines: [['102.002', 'debit', '30000', { cur: 'GBP' }], ['340', 'credit', '__GBP30000__']],
      },
      {
        on: date(7, 15), text: 'Daire satışı — B Blok 1. kat',
        lines: [['120', 'debit', '2320000', { party: 'sarah', dueDays: 30 }], ['600', 'credit', '2000000'], ['391', 'credit', '320000']],
      },
      { on: date(8, 3), text: 'Daire satışı tahsilatı (B Blok)', lines: [['102.001', 'debit', '1000000'], ['120', 'credit', '1000000', { party: 'sarah' }]] },
      {
        on: date(8, 20), text: 'Hazır beton alımı — Hazır Beton Ltd.',
        lines: [['150', 'debit', '260000'], ['191', 'debit', '41600'], ['320', 'credit', '301600', { party: 'beton', dueDays: 30 }]],
      },
      {
        on: date(9, 12), text: 'Hatalı gider kaydı (ters çevrilecek)',
        lines: [['770', 'debit', '12500'], ['102.001', 'credit', '12500']], reverseOn: date(9, 14),
      },
      { on: date(9, 26), text: 'Eylül şantiye ofisi kirası (taslak)', lines: [['770', 'debit', '45000'], ['102.001', 'credit', '45000']], post: false },
    ];

    let created = 0;
    for (const s of specs) {
      if (s.on > today) continue;
      const gbpFx = rateAt('GBP', s.on);
      const lines = s.lines.map(([code, side, amount, opts]) => {
        const cur = opts?.cur ?? 'TRY';
        let value = amount;
        if (amount.startsWith('__GBP')) {
          // TL karşılığı: GBP tutar × o günün kuru (hesaplamayı sunucuyla aynı yuvarlama ile yap)
          value = applyRate(amount.replace(/\D/g, ''), gbpFx).toFixed(2);
        }
        return {
          accountId: acc(code),
          currency: cur,
          description: opts?.desc,
          debit: side === 'debit' ? value : '0',
          credit: side === 'credit' ? value : '0',
          ...(cur !== 'TRY' ? { fxRate: String(gbpFx) } : {}),
          ...(opts?.party ? { partyId: partyId.get(opts.party)! } : {}),
          ...(opts?.party && opts.dueDays !== undefined ? { dueDate: addDays(s.on, opts.dueDays) } : {}),
        };
      }) as CreateJournalInput['lines'];

      const entry = await createJournalEntry(tx, ctx, {
        entryDate: s.on,
        description: s.text,
        lines,
        post: s.post ?? true,
      });
      created++;
      if (s.reverseOn && s.reverseOn <= today) {
        await reverseJournalEntry(tx, ctx, entry.id, { entryDate: s.reverseOn });
      }
    }

    // Geçmiş aylar kapansın (yılın ilk yarısı)
    for (let m = 1; m <= 6; m++) {
      const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
      const p = await findPeriodForDate(tx, date(m, last));
      if (p && date(m, last) < today) await closePeriod(tx, p.id, userId);
    }

    console.log(`Demo verisi yüklendi: ${company.name} (${created} yevmiye)`);
    console.log(`  Giriş:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('  Ekip:   muhasebe@ornek.local (muhasebeci), izleyici@ornek.local (izleyici) — aynı şifre');
  });
}

try {
  await main();
} finally {
  await handle.close();
}

