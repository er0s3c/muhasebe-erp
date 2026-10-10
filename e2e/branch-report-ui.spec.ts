import { expect, test } from './fixtures';

test('satış ve alış raporunda şube/kullanıcı kırılımı mobil ve temalarda okunur, dışa aktarım aynı filtreyi kullanır', async ({ page }) => {
  const companyId = '019b29e1-7ac3-7000-8000-000000000001';
  const errors: string[] = [], exports: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('activeCompanyId', id), companyId);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const company = { id: companyId, name: 'Rapor deneme şirketi', sector: 'COMMERCE', baseCurrency: 'TRY', reportingCurrency: null, role: 'owner', jurisdiction: 'TR', timeZone: 'Europe/Istanbul' };
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/refresh') return json({ accessToken: 'fixture' });
    if (path === '/api/public-config' || path === '/api/license') return json({ enforced: false, state: 'active', license: { enforced: false, state: 'active' }, usage: { companies: 1, devices: 1 }, isOwner: true });
    if (path === '/api/me') return json({ user: { id: companyId, fullName: 'Rapor kullanıcısı', email: 'review@example.com', emailVerified: true }, companies: [company] });
    if (path === '/api/navigation') return json({ company, permissions: ['workspace.use', 'reports.read'], modules: ['core.invoices'], moduleAccess: {}, groups: [] });
    if (path === '/api/company/branches') return json({ branches: [] });
    if (path === '/api/company') return json({ company: { ...company, taxOffice: null, taxNumber: null, address: null } });
    if (path.includes('notifications')) return json({ count: 0, notifications: [] });
    if (path === '/api/exports/access') return json({ reports: { 'sales-report': true, 'purchase-report': true } });
    if (path.startsWith('/api/reports/')) return json({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), groupBy: url.searchParams.get('groupBy'), rows: [{ key: 'a', label: url.searchParams.get('groupBy') === 'creator' ? 'Uzun Adlı Kaydı Oluşturan Kullanıcı' : 'Uzun Adlı Merkez Satış ve Dağıtım Şubesi', code: null, docCount: 3, qty: null, net: '420.0000', vat: '67.2000', gross: '487.2000' }, { key: '-', label: 'Şubeye atanmamış', code: null, docCount: 1, qty: null, net: '50.0000', vat: '8.0000', gross: '58.0000' }], totals: { docCount: 4, net: '470.0000', vat: '75.2000', gross: '545.2000' } });
    if (path.startsWith('/api/exports/')) {
      exports.push(`${path}?${url.searchParams}`);
      return route.fulfill({ contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="rapor.csv"' }, body: 'Şube;Net\nŞubeye atanmamış;50\n' });
    }
    return json({});
  });
  for (const side of ['sales', 'purchases']) {
    await page.goto(`/reports/${side}`);
    try { await expect(page.getByRole('heading', { name: side === 'sales' ? 'Satış raporu' : 'Alış raporu', exact: true })).toBeVisible(); }
    catch (error) { throw new Error(await page.locator('body').textContent() ?? 'Rapor açılamadı', { cause: error }); }
    for (const group of ['Şube', 'Kaydı oluşturan kullanıcı', 'Fatura']) {
      await page.getByRole('tab', { name: group, exact: true }).click();
      await expect(page.getByRole('columnheader', { name: group === 'Fatura' ? (side === 'sales' ? 'Müşteri' : 'Tedarikçi') : group, exact: true })).toBeVisible();
      expect(await page.locator('table').evaluate(table => {
        const cols = (selector: string) => [...table.querySelectorAll<HTMLTableCellElement>(selector)].reduce((sum, cell) => sum + cell.colSpan, 0);
        return cols('thead tr:first-child th') === cols('tfoot tr:first-child td');
      })).toBe(true);
      for (const width of [1280, 390]) for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
        await expect(page.getByRole('tab', { name: group, exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Dışa aktar', exact: true })).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: `test-results/review-report-${side}-${group === 'Şube' ? 'branch' : group === 'Fatura' ? 'invoice' : 'creator'}-${width}-${dark ? 'dark' : 'light'}.png` });
      }
      await page.getByRole('button', { name: 'Dışa aktar', exact: true }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: /CSV/ }).click();
      expect((await download).suggestedFilename()).toBe('rapor.csv');
    }
  }
  expect(exports).toHaveLength(6);
  expect(exports.filter(url => url.includes('groupBy=branch'))).toHaveLength(2);
  expect(exports.filter(url => url.includes('groupBy=creator'))).toHaveLength(2);
  expect(errors).toEqual([]);
});
