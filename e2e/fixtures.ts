import { test as base, type BrowserContext } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * V3'te ana menü grupları kapalı açılır; yalnız etkin sayfanın grubu açıktır ve her sayfa yüklemesinde bu durum
 * sıfırlanır. Senaryolar menüdeki bağlantılara (ve yetkiyle gizlenmiş bağlantıların yokluğuna) bakar; bu nedenle
 * her grup, kullanıcı açmış gibi bir kez açılır. Senaryonun kendisinin kapattığı grup yeniden açılmaz.
 */
function openMenuGroups() {
  const opened = new WeakSet<Element>();
  const open = () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Ana menü"] button[aria-controls$="-items"][aria-expanded="false"]',
    );
    for (const button of buttons) {
      if (opened.has(button)) continue;
      opened.add(button);
      button.click();
    }
  };
  new MutationObserver(open).observe(document, { childList: true, subtree: true });
}

/** `browser.newContext()` ile açılan ek oturumlar için. */
export async function withOpenMenu(context: BrowserContext) {
  await context.addInitScript(openMenuGroups);
  return context;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await use(await withOpenMenu(context));
  },
});
