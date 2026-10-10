import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { buildDisplayNavigation } from '../apps/web/src/components/layout/navigation';

test('iki demo şirketindeki bütün menü sayfaları: tasarım, durum dili ve taşma', async ({
  page,
  request,
}) => {
  test.setTimeout(900_000);
  const phase = process.env.UI_AUDIT_PHASE ?? 'after';
  const out = `.cache/ui-audit/${phase}`;
  mkdirSync(out, { recursive: true });
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill('Demo-Sifre-123');
  const logged = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  const token = (await (await logged).json()).accessToken;
  await page.getByRole('button', { name: 'Şirket değiştir' }).waitFor();
  const headers = { authorization: 'Bearer ' + token };
  const me = await (await request.get('/api/me', { headers })).json();
  const companies = me.companies.filter((c: { name: string }) =>
    ['Örnek İnşaat Ltd.', 'Ada Üretim ve Toptan Ticaret Demo'].includes(c.name),
  );
  expect(companies).toHaveLength(2);
  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const company of companies) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: 'Şirket değiştir' }).click();
    await page
      .getByRole('menuitem', {
        name: new RegExp(company.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      })
      .click();
    const navigation = await (
      await request.get('/api/navigation', {
        headers: { ...headers, 'x-company-id': company.id },
      })
    ).json();
    const routes = [
      ...new Set<string>(
        // Kullanıcının gördüğü menü: V3'te birleştirilen sayfalar (ör. Entegrasyonlar) yeni adresleriyle denetlenir
        buildDisplayNavigation(navigation.groups).flatMap((g) => g.items.map((i) => i.path)),
      ),
    ].filter(
      (path) => !process.env.UI_AUDIT_FILTER || new RegExp(process.env.UI_AUDIT_FILTER).test(path),
    );
    for (const path of routes) {
      errors.length = 0;
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(path, { timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      await page.waitForTimeout(120);
      expect(new URL(page.url()).pathname, `${path} oturum yönlendirmesi`).toBe(path.split('?')[0]);
      await expect(page.locator('main h1').first(), `${path} gerçek sayfa içeriği`).toBeVisible();
      const inspect = async () =>
        page.locator('main').evaluate((main) => {
          const text = main.innerText;
          const uuid =
            text.match(
              /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
            ) ?? [];
          const raw: string[] = [];
          const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const p = n.parentElement;
            if (!p || p.closest('option,script,style,pre,code') || !p.getClientRects().length)
              continue;
            const v = n.textContent?.trim() ?? '';
            if (
              /^(cancelled|draft|published|completed|configured|disconnected|quarantine|actual|standard|no_data|no_actual_data|manufacture|purchase|machine|person|center|planned|part_received|adapter_required)$/.test(
                v,
              )
            )
              raw.push(v);
          }
          return {
            title: main.querySelector('h1')?.textContent,
            uuid: [...new Set(uuid)],
            raw: [...new Set(raw)],
            overflow: document.documentElement.scrollWidth > innerWidth + 2,
            mainOverflow: main.scrollWidth > main.clientWidth + 2,
            nestedForms: main.querySelectorAll('form form').length,
            documentScroll: document.documentElement.scrollHeight > innerHeight + 4,
            nestedScrolls: Array.from(main.querySelectorAll<HTMLElement>('*'))
              .filter((element) => {
                const style = getComputedStyle(element);
                return element.getClientRects().length > 0 && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4;
              })
              .map((element) => ({ tag: element.tagName, className: element.className, text: element.innerText.slice(0, 100) })),
            clippedButtons: Array.from(main.querySelectorAll<HTMLButtonElement>('button'))
              .filter((element) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]') && element.innerText.trim() && element.scrollHeight > element.clientHeight + 4)
              .map((element) => element.innerText.trim()),
            error:
              /Beklenmeyen bir hata oluştu|Sayfa bulunamadı|Bu bölüm şirketinizde etkin değil|Bu sayfayı görme yetkiniz yok/.test(
                text,
              ),
          };
        });
      const desktop = await inspect();
      const name = company.sector + '-' + path.replace(/[^a-z0-9]+/gi, '-');
      await page.screenshot({ path: `${out}/${name}.png` });
      const scrolled = await page.locator('main').evaluate((main) => {
        const hasMore = main.scrollHeight > main.clientHeight + 20;
        if (hasMore) main.scrollTop = main.scrollHeight;
        return hasMore;
      });
      if (scrolled) await page.screenshot({ path: `${out}/${name}-bottom.png` });
      await page.locator('main').evaluate((main) => {
        main.scrollTop = 0;
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await inspect();
      await page.screenshot({ path: `${out}/${name}-mobile.png` });
      await page.setViewportSize({ width: 1280, height: 720 });
      const compact = await inspect();
      await page.screenshot({ path: `${out}/${name}-compact.png` });
      results.push({ company: company.name, path, desktop, mobile, compact, errors: [...errors] });
      writeFileSync(`${out}/report.json`, JSON.stringify(results, null, 2));
      console.log(
        `${company.sector} ${path}: ${desktop.uuid.length} kimlik, ${desktop.raw.length} ham durum`,
      );
    }
  }
  writeFileSync(`${out}/report.json`, JSON.stringify(results, null, 2));
  if (phase !== 'before')
    for (const r of results) {
      const d = r.desktop as {
        error: boolean;
        raw: string[];
        uuid: string[];
        overflow: boolean;
        nestedForms: number;
      };
      const m = r.mobile as { overflow: boolean };
      expect.soft(d.error, String(r.path)).toBe(false);
      expect
        .soft((r.desktop as { title?: string }).title, String(r.path) + ' sayfa başlığı')
        .toBeTruthy();
      expect.soft(d.raw, String(r.path)).toEqual([]);
      expect.soft(d.uuid, String(r.path) + ' teknik kimlik').toEqual([]);
      expect.soft(d.overflow || m.overflow, String(r.path) + ' yatay taşma').toBe(false);
      expect.soft(d.nestedForms, String(r.path) + ' iç içe form').toBe(0);
      expect.soft(r.errors, String(r.path)).toEqual([]);
      for (const viewport of ['desktop', 'mobile', 'compact']) {
        const layout = r[viewport] as { documentScroll: boolean; nestedScrolls: unknown[]; clippedButtons: string[]; overflow: boolean; mainOverflow: boolean };
        expect.soft(layout.documentScroll, `${r.path} ${viewport} belge kaydırması`).toBe(false);
        expect.soft(layout.nestedScrolls, `${r.path} ${viewport} iç dikey kaydırma`).toEqual([]);
        expect.soft(layout.clippedButtons, `${r.path} ${viewport} kesilen düğme yazısı`).toEqual([]);
        expect.soft(layout.overflow, `${r.path} ${viewport} yatay taşma`).toBe(false);
        expect.soft(layout.mainOverflow, `${r.path} ${viewport} içerik yatay taşması`).toBe(false);
      }
    }
});
