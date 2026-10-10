import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

const PASSWORD = 'Sifre-12345-xyz';
const year = new Date().getFullYear();
const today = new Date().toISOString().slice(0, 10);

async function signUpWithCompany(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

test('konsolidasyon: iki şirket → grup → konsolide mizan (kur, eliminasyon) → döviz pozisyonu → yönetici özeti → dışa aktarma', async ({ page }) => {
  const email = `e2e-konsol-${Date.now()}@example.com`;
  await signUpWithCompany(page, email);
  const nav = page.getByRole('navigation', { name: 'Ana menü' });

  // İkinci şirket (GBP defter para birimi): şirket değiştirici menüsünden
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: 'Yeni şirket' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel UK Ltd.');
  await page.getByLabel('Defter para birimi').selectOption('GBP');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();

  // Defter verisi API ile hazırlanır (arayüz akışı konsolidasyon ekranlarıdır)
  const login = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  const token = (await login.json()).accessToken as string;
  const me = (await (await page.request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json()).companies as { id: string; name: string }[];
  const A = me.find((c) => c.name === 'Yücel İnşaat Ltd.')!;
  const B = me.find((c) => c.name === 'Yücel UK Ltd.')!;
  const call = async (companyId: string, method: 'get' | 'post' | 'put', url: string, data?: unknown) => {
    const res = await page.request[method](url, { headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId }, data });
    expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  const ids = async (companyId: string) => Object.fromEntries(((await call(companyId, 'get', '/api/accounts')).accounts as { code: string; id: string }[]).map((a) => [a.code, a.id]));
  const journal = (companyId: string, d: string, cur: string, lines: [string, 'debit' | 'credit', string][], idMap: Record<string, string>) =>
    call(companyId, 'post', '/api/journal-entries', { entryDate: `${year}-${d}`, description: 'E2E', post: true, lines: lines.map(([code, side, amount]) => ({ accountId: idMap[code], currency: cur, [side]: amount })) });
  const ia = await ids(A.id);
  const ib = await ids(B.id);
  // A'da dövizli (USD) banka hesabı ve kuru: döviz pozisyonu için
  const usd = (await call(A.id, 'post', '/api/treasury/accounts', { kind: 'bank', name: 'KTB USD', currency: 'USD' })).account as { id: string };
  await call(A.id, 'post', '/api/treasury/transactions', { type: 'other_receipt', date: `${year}-01-20`, accountId: usd.id, amount: '1000', glAccountId: ia['500'], fxRate: '30' });
  await call(A.id, 'put', '/api/exchange-rates', { rateDate: today, currencyCode: 'USD', quoteCode: 'TRY', buy: '35' });
  await journal(A.id, '01-10', 'TRY', [['100', 'debit', '1000'], ['500', 'credit', '1000']], ia);
  await journal(A.id, '02-10', 'TRY', [['100', 'debit', '600'], ['600', 'credit', '600']], ia);
  await journal(A.id, '03-10', 'TRY', [['632', 'debit', '200'], ['100', 'credit', '200']], ia);
  await journal(A.id, '04-10', 'TRY', [['136', 'debit', '300'], ['600', 'credit', '300']], ia);
  await journal(B.id, '01-10', 'GBP', [['100', 'debit', '500'], ['500', 'credit', '500']], ib);
  await journal(B.id, '02-10', 'GBP', [['632', 'debit', '50'], ['100', 'credit', '50']], ib);
  await journal(B.id, '03-10', 'GBP', [['632', 'debit', '7.5'], ['336', 'credit', '7.5']], ib);

  // Konsolidasyon sayfası: grup oluştur
  await nav.getByRole('link', { name: 'Konsolidasyon' }).click();
  await expect(page.getByRole('heading', { name: 'Çoklu şirket konsolidasyonu', level: 1 })).toBeVisible();
  const groups = page.getByTestId('groups-panel');
  await groups.getByLabel('Grup adı').fill('Yücel Grubu');
  await groups.getByLabel(/Yücel İnşaat Ltd\./).check();
  await groups.getByLabel(/Yücel UK Ltd\./).check();
  await groups.getByRole('button', { name: 'Grubu oluştur' }).click();
  await expect(page.getByText('Grup oluşturuldu')).toBeVisible();
  const card = page.getByTestId('group-card');
  await expect(card.getByTestId('group-member')).toHaveCount(2);
  await expect(card.getByText('Erişim var')).toHaveCount(2);

  // Konsolide mizan: GBP→TRY elle kapanış kuru 40
  await page.getByRole('tab', { name: 'Konsolide mizan ve tablolar' }).click();
  await page.getByLabel('Elle kapanış kuru').fill('GBP:40');
  await page.getByRole('button', { name: 'Çalıştır' }).click();
  const report = page.getByTestId('consolidated-report');
  await expect(report).toBeVisible();
  await expect(report.getByTestId('tb-100-consolidated')).toHaveText('19.400,00'); // 1.400 + 450 × 40
  await expect(report.getByTestId('tb-632-consolidated')).toHaveText('2.500,00'); // 200 + 57,5 × 40
  await expect(report.getByTestId('tb-total')).toHaveText('0,00');
  await expect(report.getByTestId('balance-sheet')).toBeVisible();
  await expect(report.getByTestId('income-statement').getByTestId('line-net_sales')).toContainText('900,00');
  await expect(report.getByText('Doğrulanmadı').first()).toBeVisible();

  // Eliminasyon: A'nın 136 alacağı ↔ B'nin 336 borcu (300 TRY)
  await page.getByRole('tab', { name: 'Eliminasyonlar' }).click();
  const panel = page.getByTestId('eliminations-panel');
  await panel.getByLabel('Açıklama').fill('A alacağı / B borcu');
  await panel.getByTestId('elim-line-0').getByLabel('Kod').fill('336');
  await panel.getByTestId('elim-line-0').getByLabel(/Tutar/).fill('300');
  await panel.getByTestId('elim-line-1').getByLabel('Kod').fill('136');
  await panel.getByTestId('elim-line-1').getByLabel('Taraf').selectOption('credit');
  await panel.getByTestId('elim-line-1').getByLabel(/Tutar/).fill('300');
  await panel.getByRole('button', { name: 'Eliminasyonu kaydet' }).click();
  await expect(page.getByText('Eliminasyon kaydedildi')).toBeVisible();
  await expect(panel.getByTestId('elim-row')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Konsolide mizan ve tablolar' }).click();
  await page.getByRole('button', { name: 'Çalıştır' }).click();
  await expect(page.getByTestId('tb-136-consolidated')).toHaveText('0,00'); // eliminasyondan sonra
  await expect(page.getByTestId('tb-336-consolidated')).toHaveText('0,00');
  await expect(page.getByTestId('tb-total')).toHaveText('0,00');

  // Dışa aktarma (xlsx)
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Dışa aktar', exact: true }).click();
  await page.getByRole('menuitem', { name: /Excel \(\.xlsx\)/ }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^konsolide-\d{4}-01-01_\d{4}-\d{2}-\d{2}\.xlsx$/);

  // Döviz pozisyonu (grup): USD net 1.000
  await page.getByRole('tab', { name: 'Döviz pozisyonu' }).click();
  await page.getByRole('button', { name: 'Çalıştır' }).click();
  const fxRow = page.getByTestId('group-fx-row-USD');
  await expect(fxRow).toBeVisible();
  await expect(fxRow).toContainText('1.000,00');

  // Yönetici özeti (grup)
  await page.getByRole('tab', { name: 'Yönetici özeti' }).click();
  await page.getByLabel('Elle kur (dönem sonu)').fill('GBP:40');
  await page.getByRole('button', { name: 'Çalıştır' }).click();
  const exec = page.getByTestId('executive-summary');
  await expect(exec).toBeVisible();
  await expect(exec.getByTestId('kpi-revenue')).toContainText('900,00');
  await expect(exec.getByTestId('kpi-grossMarginPct')).toBeVisible();

  // Şirket düzeyi: yönetici özeti ve döviz pozisyonu sayfaları (menüden)
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: 'Yücel İnşaat Ltd.' }).click();
  await nav.getByRole('link', { name: 'Yönetici özeti' }).click();
  await expect(page.getByRole('heading', { name: 'Yönetici özet raporu', level: 1 })).toBeVisible();
  await expect(page.getByTestId('kpi-revenue')).toContainText('900,00');
  await expect(page.getByTestId('kpi-cash')).toBeVisible();
  await nav.getByRole('link', { name: 'Döviz pozisyonu' }).click();
  await expect(page.getByRole('heading', { name: 'Döviz pozisyon raporu', level: 1 })).toBeVisible();
  await expect(page.getByTestId('fx-row-USD')).toContainText('1.000,00');
});
