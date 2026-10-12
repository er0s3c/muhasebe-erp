import { expect, test } from './fixtures';

const companyId = '019b29e1-7ac3-7000-8000-000000000001';
const otherId = '019b29e1-7ac3-7000-8000-000000000002';
test('asistan şirket kapsamı, uzun metin, tek kaydırma ve dokunarak sayfa rehberi', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const conversations: { company: string; history: unknown[] }[] = [];
  await page.addInitScript(id => localStorage.setItem('activeCompanyId', id), companyId);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const activeId = request.headers()['x-company-id'] ?? companyId;
    const company = (id: string) => ({ id, name: id === companyId ? 'Birinci şirket' : 'İkinci şirket', sector: 'COMMERCE', baseCurrency: 'TRY', reportingCurrency: null, role: 'owner', jurisdiction: 'TR', timeZone: 'Europe/Istanbul' });
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/refresh') return json({ accessToken: 'fixture' });
    if (path === '/api/public-config') return json({ version: '0.1.0', registrationEnabled: true, license: { enforced: false, state: 'active' } });
    if (path === '/api/license') return json({ enforced: false, state: 'active', usage: { companies: 2, devices: 1 }, isOwner: true });
    if (path === '/api/me') return json({ user: { id: '019b29e1-7ac3-7000-8000-000000000003', fullName: 'Deneme kullanıcısı', email: 'review@example.com', emailVerified: true, mustChangePassword: false }, companies: [company(companyId), company(otherId)] });
    if (path === '/api/navigation') return json({ company: company(activeId), permissions: ['workspace.use', 'settings.read', 'inventory.read', 'inventory.move'], modules: ['core.dashboard', 'core.settings', 'core.inventory'], moduleAccess: {}, groups: [] });
    if (path === '/api/company/branches') return json({ branches: [] });
    if (path === '/api/company') return json({ company: { ...company(activeId), address: null, taxNumber: null } });
    if (path.includes('notifications')) return json({ count: 0, unread: 0, critical: 0, hasCritical: false, notifications: [] });
    if (path === '/api/offline-drafts/bootstrap') return json({ companyId: activeId, userId: '019b29e1-7ac3-7000-8000-000000000003', companyName: company(activeId).name, branchSelection: 'all', today: '2026-10-09', timeZone: 'Europe/Istanbul', kinds: ['field_task'], warehouses: [], items: [], truncated: false });
    if (path === '/api/ai/chat') {
      const body = request.postDataJSON(); conversations.push({ company: activeId, history: body.history });
      return json({ success: true, answer: activeId === companyId ? 'Birinci şirketin gizli cevabı ' + 'Uzunmetin'.repeat(150) : 'İkinci şirketin cevabı' });
    }
    return json({});
  });
  await page.goto('/workspace/offline');
  await expect(page.getByRole('heading', { name: 'Çevrimdışı depo ve saha' })).toBeVisible();
  const help = page.getByRole('button', { name: /hakkında rehber/ }).first();
  await help.click(); await expect(page.getByText('Modül Kullanım Rehberi', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ada AI Asistanı (Ctrl+J)' }).click();
  await page.getByRole('textbox', { name: 'Asistana sorunuz' }).fill('Birinci şirkette ne var?');
  await page.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.getByText(/Birinci şirketin gizli cevabı/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Asistana sorunuz' })).toBeEnabled();
  for (const dark of [false, true]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
    const dialog = page.getByRole('dialog');
    const scroll = await dialog.evaluate(el => ({ overflow: el.scrollWidth > el.clientWidth + 1, vertical: [...el.querySelectorAll<HTMLElement>('*')].filter(child => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1).length }));
    expect(scroll.overflow).toBe(false); expect(scroll.vertical).toBe(1);
    await page.screenshot({ animations: 'disabled', path: `test-results/review-ai-${dark ? 'dark' : 'light'}.png` });
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Kapat', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Şirket değiştir', exact: true }).click();
  await page.getByRole('menuitem', { name: /İkinci şirket/ }).click();
  await page.getByRole('button', { name: 'Ada AI Asistanı (Ctrl+J)' }).click();
  await expect(page.getByText(/Birinci şirketin gizli cevabı/)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Asistana sorunuz' }).fill('İkinci şirkette ne var?');
  await page.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.getByText('İkinci şirketin cevabı', { exact: true })).toBeVisible();
  expect(conversations).toEqual([{ company: companyId, history: [] }, { company: otherId, history: [] }]);
  expect(errors).toEqual([]);
});
