import type { Page } from '@playwright/test';

/** Menus are collapsible in V2; open the permitted group before using its link. */
export async function navigateMenu(page: Page, name: string | RegExp) {
  const menu = page.getByRole('navigation', { name: 'Ana menü' });
  const link = menu.getByRole('link', { name });
  if (!await link.isVisible()) {
    const panelId = await link.evaluate(element => element.closest('ul[hidden]')?.id);
    if (panelId) await menu.locator('button[aria-controls]').filter({ hasNot: page.locator('[disabled]') })
      .evaluateAll((buttons, id) => { (buttons.find(button => button.getAttribute('aria-controls') === id) as HTMLButtonElement | undefined)?.click(); }, panelId);
  }
  await link.click();
}
