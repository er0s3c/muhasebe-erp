import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

const companyId = '019b29e1-7ac3-7000-8000-000000000001';
const orderId = '019b29e1-7ac3-7000-8000-000000000010';
const resourceId = '019b29e1-7ac3-7000-8000-000000000020';
const secondResourceId = '019b29e1-7ac3-7000-8000-000000000021';
const inactiveResourceId = '019b29e1-7ac3-7000-8000-000000000022';
const draftId = '019b29e1-7ac3-7000-8000-000000000030';
const publishedId = '019b29e1-7ac3-7000-8000-000000000031';
const previewId = '019b29e1-7ac3-7000-8000-000000000032';
const permissions = ['workspace.use', 'manufacturing.planning.read', 'manufacturing.planning.manage', 'manufacturing.planning.approve', 'manufacturing.production.read'];

type PlanningJob = {
  orderId: string; operationKey: string; resourceId: string; minutes: number;
  priority?: number; predecessor?: string; durationSource?: string;
};
type FixturePlan = {
  id: string; code: string; status: string; anchor: string; direction: string;
  previewOnly: boolean; version: number; jobs: PlanningJob[];
  operations: { orderId: string; operationKey: string; resourceId: string; start: string; end: string }[];
};
type Submission = { path: string; method: string; body: Record<string, unknown> };

function plan(id: string, code: string, status: string, previewOnly = false): FixturePlan {
  return {
    id, code, status, previewOnly, version: 1, anchor: '2026-10-12T05:00:00.000Z', direction: 'forward',
    jobs: [{ orderId, operationKey: 'cut', resourceId, minutes: 120 }],
    operations: [{ orderId, operationKey: 'cut', resourceId, start: '2026-10-12T05:00:00.000Z', end: '2026-10-12T07:00:00.000Z' }],
  };
}

async function mockPlanning(page: Page, options: { permissions?: string[]; rejectFirstPublish?: boolean } = {}) {
  const plans = [plan(draftId, 'PLN-001', 'draft'), plan(publishedId, 'PLN-002', 'published'), plan(previewId, 'PLN-DENEME', 'draft', true)];
  const submissions: Submission[] = [], errors: string[] = [];
  let rejected = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('activeCompanyId', id), companyId);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const company = { id: companyId, name: 'Planlama deneme şirketi', sector: 'MANUFACTURING_WHOLESALE', baseCurrency: 'TRY', reportingCurrency: null, role: 'owner', jurisdiction: 'TR', timeZone: 'Europe/Istanbul' };
    if (path === '/api/auth/refresh') return json({ accessToken: 'fixture' });
    if (path === '/api/public-config' || path === '/api/license') return json({ enforced: false, state: 'active', license: { enforced: false, state: 'active' }, usage: { companies: 1, devices: 1 }, isOwner: true });
    if (path === '/api/me') return json({ user: { id: companyId, fullName: 'Planlama kullanıcısı', email: 'planning@example.com', emailVerified: true }, companies: [company] });
    if (path === '/api/navigation') return json({ company, permissions: options.permissions ?? permissions, modules: ['manufacturing.planning', 'manufacturing.production'], moduleAccess: {}, groups: [] });
    if (path === '/api/company/branches') return json({ branches: [] });
    if (path === '/api/company') return json({ company: { ...company, taxOffice: null, taxNumber: null, address: null } });
    if (path.includes('notifications')) return json({ count: 0, notifications: [] });
    if (path === '/api/manufacturing/resources') return json({ records: [
      { id: resourceId, code: 'KES-01', name: 'Uzun Adlı Otomatik Kesim ve Hazırlık Tezgâhı', type: 'machine', capacity: 1, status: 'active' },
      { id: secondResourceId, code: 'MON-01', name: 'Montaj ekibi', type: 'center', capacity: 2, status: 'active' },
      { id: inactiveResourceId, code: 'KAP-01', name: 'Kullanıma kapalı makine', type: 'machine', capacity: 1, status: 'inactive' },
    ] });
    if (path === '/api/manufacturing/production/orders') return json({ orders: [{
      id: orderId, code: 'UE-001', quantity: '10', status: 'in_progress', operations: [
        { key: 'prepare', name: 'Hazırlık', plannedMinutes: '30', goodQty: '10' },
        { key: 'cut', name: 'Kesim', plannedMinutes: '120', goodQty: '0' },
        { key: 'assembly', name: 'Montaj ve son kontrol', goodQty: '0' },
      ],
    }] });
    if (path.endsWith('/estimates')) return json({ operations: [
      { operationKey: 'cut', resources: [
        { resourceId: inactiveResourceId, minutes: 10, source: 'standard', sampleCount: 0, confidence: 'low', lowerMinutes: 10, upperMinutes: 10 },
        { resourceId, minutes: 120, source: 'actual', sampleCount: 8, confidence: 'high', lowerMinutes: 100, upperMinutes: 140 },
      ] },
      { operationKey: 'assembly', resources: [{ resourceId: secondResourceId, minutes: 0, source: 'no_data', sampleCount: 0, confidence: 'low', lowerMinutes: 0, upperMinutes: 0 }] },
    ] });
    if (path === '/api/manufacturing/planning/schedules' && method === 'GET') return json({ records: plans });
    if (path === '/api/manufacturing/planning/capacity') return json({ resources: [
      { id: resourceId, name: 'Uzun Adlı Otomatik Kesim ve Hazırlık Tezgâhı', capacityMinutes: 1200, loadMinutes: 300, loadPct: 25, noCalendar: false },
      { id: secondResourceId, name: 'Montaj ekibi', capacityMinutes: 2400, loadMinutes: 2700, loadPct: 112.5, noCalendar: false },
      { id: inactiveResourceId, name: 'Takvimi bulunmayan kaynak', capacityMinutes: 0, loadMinutes: 0, loadPct: null, noCalendar: true },
    ] });
    if (path === '/api/manufacturing/reports') return json({ history: [{ days: 30, goodQty: '80', minutes: 1200, minutesPerUnit: 15, source: 'actual' }] });
    if (path === '/api/manufacturing/planning/lookups') return json({ employees: [] });
    if (path === '/api/manufacturing/departments' && method === 'GET') return json({ records: [] });
    if (path.startsWith('/api/manufacturing/custom-values/') && method === 'GET') return json({ fields: [], values: {} });
    if (method === 'POST' || method === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push({ path, method, body });
      if (path === '/api/manufacturing/planning/schedules') {
        const created = plan('019b29e1-7ac3-7000-8000-000000000033', 'PLN-003', 'draft');
        created.jobs = body.jobs as PlanningJob[];
        created.direction = body.direction as string;
        created.anchor = body.anchor as string;
        plans.push(created);
        return json({ schedule: created });
      }
      const existing = plans.find(item => path.includes(item.id));
      if (existing && path.endsWith('/publish')) {
        if (options.rejectFirstPublish && !rejected) {
          rejected = true;
          return json({ error: { code: 'CAPACITY_CHANGED', message: 'Kaynak takvimi değişti. Planı yeniden kontrol edin.' } }, 409);
        }
        existing.status = 'published';
      } else if (existing && path.endsWith('/cancel')) existing.status = 'cancelled';
      return json({ record: existing ?? { id: 'calendar-fixture' } });
    }
    return json({});
  });
  await page.goto('/manufacturing/planning');
  await expect(page.getByRole('heading', { name: 'Kapasite ve termin planlama', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'PLN-001', exact: true })).toBeVisible();
  return { submissions, errors };
}

test('plan, kapasite ve kaynaklar ayrı sekmelerde; masaüstü ve mobilde iki temada okunur', async ({ page }, testInfo) => {
  const fixture = await mockPlanning(page);
  await expect(page.getByRole('tab', { name: 'Planlar', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Alternatif plan oluştur', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Haftalık çalışma takvimi', exact: true })).not.toBeVisible();
  for (const [index, label] of ['Planlar', 'Kapasite', 'Takvim ve kaynaklar'].entries()) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    if (label === 'Kapasite') {
      await expect(page.getByText('20 saat', { exact: true })).toBeVisible();
      await expect(page.getByText('5 saat', { exact: true })).toBeVisible();
      await expect(page.getByText('Kapasite aşılıyor', { exact: true })).toBeVisible();
      await expect(page.getByText('5 saat kapasite fazlası var.', { exact: false })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Montaj ekibi kapasite doluluğu' })).toHaveAttribute('aria-valuenow', '100');
      await expect(page.getByText('Çalışma süresi yok', { exact: true })).toBeVisible();
    }
    for (const width of [1280, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
      await page.getByRole('main').evaluate(main => { main.scrollTop = 0; });
      await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yeni plan oluştur', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(page.getByRole('main')).not.toContainText(/019b29e1-|Beklenmeyen bir hata/);
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`planning-${index}-${width}-${dark ? 'dark' : 'light'}.png`) });
      await page.getByRole('region', { name: label, exact: true }).evaluate(section => section.scrollIntoView({ block: 'start' }));
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`planning-content-${index}-${width}-${dark ? 'dark' : 'light'}.png`) });
    }
  }
  expect(fixture.errors).toEqual([]);
});

test('plan sihirbazı emirleri tekrarlamaz, kalan işlemler ve uygun kaynaklarla teslimden geriye planlar', async ({ page }, testInfo) => {
  const fixture = await mockPlanning(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Yeni plan oluştur', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Yeni plan oluştur', exact: true });
  await expect(dialog.getByRole('button', { name: 'Tarihe geç', exact: true })).toBeDisabled();
  await dialog.getByLabel('Üretim emri', { exact: true }).selectOption(orderId);
  await dialog.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(dialog.getByText('2 işlem eklendi', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Üretim emri', { exact: true })).not.toBeVisible();
  await dialog.getByRole('button', { name: 'Emri çıkar', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Tarihe geç', exact: true })).toBeDisabled();
  await dialog.getByLabel('Üretim emri', { exact: true }).selectOption(orderId);
  await dialog.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(dialog.getByText('2 işlem eklendi', { exact: true })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Tarihe geç', exact: true }).click();
  await dialog.getByLabel('Planlama yöntemi', { exact: true }).selectOption('backward');
  await expect(dialog.getByRole('textbox', { name: 'Hedef teslim tarihi', exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Hedef teslim saati', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Hedef teslim tarihi', exact: true }).fill('2026-10-16');
  await dialog.getByRole('textbox', { name: 'Hedef teslim saati', exact: true }).fill('17:00');
  await dialog.getByRole('button', { name: 'Planı kontrol et', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'Taslak plan oluştur', exact: true });
  await expect(form.getByText('UE-001 · Hazırlık', { exact: true })).not.toBeVisible();
  const resources = form.getByRole('combobox', { name: 'Kaynak', exact: true });
  expect(await resources.nth(0).locator('option').allTextContents()).toEqual(['Kaynak seçin', 'Uzun Adlı Otomatik Kesim ve Hazırlık Tezgâhı']);
  expect(await resources.nth(1).locator('option').allTextContents()).toEqual(['Kaynak seçin', 'Montaj ekibi']);
  await expect(resources.nth(0)).toHaveValue(resourceId);
  await expect(resources.nth(1)).toHaveValue(secondResourceId);
  const minutes = form.getByRole('spinbutton', { name: 'Süre (dakika)', exact: true });
  await expect(minutes.nth(0)).toHaveValue('120');
  await expect(minutes.nth(1)).toHaveValue('');
  const submit = dialog.getByRole('button', { name: 'Taslak plan oluştur', exact: true });
  await expect(submit).toBeDisabled();
  await minutes.nth(1).fill('1.5');
  await expect(submit).toBeDisabled();
  await minutes.nth(1).fill('60');
  await expect(submit).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('planning-wizard-mobile-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('planning-wizard-mobile-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await submit.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('article', { name: 'PLN-003', exact: true })).toBeVisible();
  const created = fixture.submissions.find(item => item.path === '/api/manufacturing/planning/schedules');
  expect(created?.body).toMatchObject({ direction: 'backward', anchor: '2026-10-16T14:00:00.000Z' });
  const jobs = created?.body.jobs as PlanningJob[];
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toMatchObject({ orderId, operationKey: 'cut', resourceId, minutes: 120, durationSource: 'actual' });
  expect(jobs[0]?.predecessor).toBeUndefined();
  expect(jobs[1]).toMatchObject({ orderId, operationKey: 'assembly', resourceId: secondResourceId, minutes: 60, predecessor: 'cut', durationSource: 'manual' });
  expect(jobs.every(job => Number.isInteger(job.minutes) && job.minutes > 0)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('deneme planı yayımlanmaz; kapasite hatası düzeltildikten sonra yeniden yayımlama ve iptal çalışır', async ({ page }) => {
  const fixture = await mockPlanning(page, { rejectFirstPublish: true });
  const preview = page.getByRole('article', { name: 'PLN-DENEME', exact: true });
  await expect(preview.getByRole('button', { name: 'Planı yayımla', exact: true })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Tarihi değiştir', exact: true })).toHaveCount(0);
  const draft = page.getByRole('article', { name: 'PLN-001', exact: true });
  await draft.getByRole('button', { name: 'Planı yayımla', exact: true }).click();
  const publishDialog = page.getByRole('dialog', { name: 'Planı yayımla', exact: true });
  await publishDialog.getByRole('button', { name: 'Planı yayımla', exact: true }).click();
  await expect(publishDialog.getByText('Kaynak takvimi değişti. Planı yeniden kontrol edin.', { exact: true })).toBeVisible();
  await expect(publishDialog).toBeVisible();
  await publishDialog.getByRole('button', { name: 'Planı yayımla', exact: true }).click();
  await expect(publishDialog).not.toBeVisible();
  await expect(draft.getByRole('button', { name: 'Planı iptal et', exact: true })).toBeVisible();
  await draft.getByRole('button', { name: 'Planı iptal et', exact: true }).click();
  await page.getByRole('dialog', { name: 'Planı iptal et', exact: true }).getByRole('button', { name: 'Kapasiteyi serbest bırak', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(draft).not.toBeVisible();
  await page.getByLabel('Gösterilecek planlar', { exact: true }).selectOption('all');
  await expect(draft.getByText('İptal', { exact: true })).toBeVisible();
  const publications = fixture.submissions.filter(item => item.path.endsWith('/publish'));
  expect(publications).toHaveLength(2);
  expect(publications[1]?.body.requestKey).toBe(publications[0]?.body.requestKey);
  expect(fixture.submissions.filter(item => item.path.endsWith('/cancel'))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('yalnızca görüntüleme yetkisinde plan ve takvim değişikliği eylemleri gösterilmez', async ({ page }) => {
  const fixture = await mockPlanning(page, { permissions: ['workspace.use', 'manufacturing.planning.read', 'manufacturing.production.read'] });
  for (const name of ['Yeni plan oluştur', 'Planı yayımla', 'Planı iptal et', 'Tarihi değiştir']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.getByText('Alternatif planlar ve maliyet karşılaştırması', { exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Tahmini kaynak maliyeti', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alternatif planı hesapla', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Takvim ve kaynaklar', exact: true }).click();
  for (const name of ['Vardiya günlerini belirle', 'Devamsızlık veya ek çalışma', 'Kaynak ekle']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('haftalık takvim gün seçimi ile oluşturulur; ters saat aralığı sunucuya gönderilmez', async ({ page }) => {
  const fixture = await mockPlanning(page);
  await page.getByRole('tab', { name: 'Takvim ve kaynaklar', exact: true }).click();
  await page.getByRole('button', { name: 'Vardiya günlerini belirle', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Vardiya günlerini belirle', exact: true });
  await dialog.getByRole('combobox', { name: 'Hangi kaynak çalışacak?', exact: true }).selectOption(resourceId);
  await dialog.getByRole('textbox', { name: 'Başlangıç tarihi', exact: true }).fill('2026-10-12');
  await dialog.getByRole('textbox', { name: 'Bitiş tarihi', exact: true }).fill('2026-10-30');
  await dialog.getByRole('textbox', { name: 'Açıklama / işlem nedeni', exact: true }).fill('Ekim vardiya düzeni');
  for (const name of ['Salı', 'Çarşamba', 'Perşembe', 'Cuma']) await dialog.getByRole('checkbox', { name, exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Cumartesi', exact: true }).check();
  await dialog.getByLabel('Tatil günleri (isteğe bağlı)', { exact: true }).fill('2026-10-29');
  await dialog.getByRole('textbox', { name: 'Çalışma bitişi', exact: true }).fill('07:00');
  await dialog.getByRole('button', { name: 'Takvimi oluştur', exact: true }).click();
  await expect(dialog.getByText('Çalışma bitişi, başlangıçtan sonra ve aynı gün içinde olmalıdır.', { exact: true })).toBeVisible();
  expect(fixture.submissions).toEqual([]);
  await expect(dialog.getByRole('checkbox', { name: 'Pazartesi', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Cumartesi', exact: true })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Çalışma bitişi', exact: true }).fill('17:00');
  await dialog.getByRole('button', { name: 'Takvimi oluştur', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({ path: '/api/manufacturing/planning/calendar-template', method: 'POST', body: {
    resourceId, from: '2026-10-12', to: '2026-10-30', weekdays: [1, 6], startTime: '08:00', endTime: '17:00', utcOffset: '+03:00', holidays: ['2026-10-29'], reason: 'Ekim vardiya düzeni',
  } });
  expect(fixture.errors).toEqual([]);
});
