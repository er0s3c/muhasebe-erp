import { expect, test, type Page } from '@playwright/test';

async function signUpWithCompany(page: Page, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

/** Şirket saat dilimine göre bu ay (YYYY-AA): sayfalar da aynı ayla açılır. */
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

/**
 * Bordro: personel + puantaj → ücret şartı, parametre (TEST DEĞERİ, doğrulanmadı), kalem → bordro aç (taslak) → puantaj ayı açıkken
 * onay kapalı → elle ek ödeme → puantajı kapat → onayla (yevmiye) → pusula (iç belge, ⚠) → ödendi → ay açılamaz → geri al + iptal → ay açılır.
 */
test('bordro: ücret şartı → parametre (doğrulanmadı) → bordro → onay → pusula → ödeme → iptal; puantaj ayı kilidi', async ({ page }) => {
  await signUpWithCompany(page, 'payroll');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const month = thisMonth();

  // Personel + puantaj: 1. gün 8 saat çalıştı
  await nav.getByRole('link', { name: 'Personel', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni personel' }).first().click();
  await dialog.getByLabel('Ad soyad').fill('Ali Demir');
  await dialog.getByLabel('İşe giriş tarihi').fill(`${month}-01`);
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Ali Demir/, level: 1 })).toBeVisible();
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByLabel('Normal saat', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Ali Demir, 1: boş', exact: true }).click();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Puantaj kaydedildi').first()).toBeVisible();

  // Bordro ayarları: parametre yokken uyarı; parametre (test değeri) açık ama doğrulanmadı; ücret şartı; kalem
  await nav.getByRole('link', { name: 'Bordro ayarları' }).click();
  await expect(page.getByRole('heading', { name: 'Bordro ayarları', level: 1 })).toBeVisible();
  await expect(page.getByText('Henüz parametre yok')).toBeVisible();
  const paramForm = page.locator('form').filter({ has: page.getByLabel('Kaynak notu') });
  await paramForm.getByLabel('Parametre', { exact: true }).selectOption('employee_social_pct');
  await paramForm.getByLabel('Değer (yüzde)').fill('10');
  await paramForm.getByLabel('Yeni parametre açık').click();
  await paramForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Parametre eklendi')).toBeVisible();
  await expect(page.getByRole('row', { name: /İşçi sosyal güvenlik primi/ })).toContainText('Oranlar doğrulanmadı');

  const termForm = page.locator('form').filter({ has: page.getByLabel('Ücret tutarı') });
  const empSelect = termForm.getByLabel('Personel', { exact: true });
  await empSelect.selectOption((await empSelect.locator('option', { hasText: 'Ali Demir' }).getAttribute('value'))!);
  await termForm.getByLabel('Ücret tutarı').fill('3000');
  await termForm.getByLabel('Geçerlilik başlangıcı').fill(`${month}-01`);
  await termForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Ücret şartı eklendi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Ali Demir/ })).toContainText('3.000,00');

  const itemForm = page.locator('form').filter({ has: page.getByLabel('Yükümlülük') });
  await itemForm.getByLabel('Kod').fill('YMK');
  await itemForm.getByLabel('Ad', { exact: true }).fill('Yemek yardımı');
  await itemForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Kalem eklendi')).toBeVisible();

  // Bordro aç: taslak, doğrulanmadı rozeti, brüt 3.000 − işçi primi 300 = net 2.700
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bordro', level: 1 })).toBeVisible();
  await expect(page.getByText(/resmî bordro değildir/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Yeni bordro' }).first().click();
  await dialog.getByRole('button', { name: 'Bordro aç' }).click();
  await expect(page.getByRole('heading', { name: `${month} bordrosu`, level: 1 })).toBeVisible();
  await expect(page.getByText('Taslak', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).getByText('Oranlar doğrulanmadı')).toBeVisible();
  const row = page.getByRole('row', { name: /Ali Demir/ });
  await expect(row).toContainText('3.000,00');
  await expect(row).toContainText('300,00');
  await expect(row).toContainText('2.700,00');

  // Puantaj ayı açık: onay kapalı
  await expect(page.getByText(new RegExp(`${month} puantaj ayı kapalı değil`)).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Onayla' })).toBeDisabled();

  // Elle ek ödeme: yemek 250 (prime/vergiye esas işaretli değil) → brüt 3.250; işçi primi prim esası 3.000 üzerinden 300 kalır → net 2.950
  await page.getByRole('button', { name: 'Ali Demir için ek ödeme veya kesinti' }).click();
  await dialog.getByLabel('Kalem', { exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel('Tutar', { exact: true }).fill('250');
  await dialog.getByRole('button', { name: 'Ekle' }).click();
  await expect(dialog.getByRole('list', { name: 'Bu personelin elle kalemleri' })).toContainText('YMK — Yemek yardımı');
  await dialog.getByRole('button', { name: 'Kapat' }).first().click();
  await expect(row).toContainText('3.250,00');
  await expect(row).toContainText('2.950,00');

  // Puantajı kapat → onay açılır
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı kapat' }).click();
  await dialog.getByRole('button', { name: 'Ayı kapat' }).click();
  await expect(page.getByText('Ay kapalı', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('row', { name: /BRD-/ }).click();
  await expect(page.getByRole('button', { name: 'Onayla' })).toBeEnabled();
  await page.getByRole('button', { name: 'Onayla' }).click();
  await expect(dialog.getByText(/yevmiye yazılır/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Onayla' }).click();
  await expect(page.getByText('Onaylı', { exact: true })).toBeVisible();
  await expect(page.getByText(/Onaylandı; yevmiye kaydı: \S+/)).toBeVisible();

  // Pusula: iç belge, doğrulanmadı uyarısı
  await page.getByRole('link', { name: 'Ali Demir bordro pusulası' }).click();
  await expect(page.getByRole('heading', { name: 'Bordro pusulası', level: 1 })).toBeVisible();
  await expect(page.getByText('TASLAK / İÇ BELGE — RESMÎ BORDRO DEĞİLDİR')).toBeVisible();
  await expect(page.getByText(/doğrulanmamış parametrelerden hesaplanmıştır/)).toBeVisible();
  await expect(page.getByRole('row', { name: /Net ödenecek/ })).toContainText('2.950,00');
  await page.getByRole('link', { name: /BRD-/ }).click();

  // Ödendi işaretle
  await page.getByRole('button', { name: 'Ödendi işaretle' }).click();
  await dialog.getByRole('button', { name: 'Ödendi işaretle' }).click();
  await expect(page.getByText('Ödendi', { exact: true })).toBeVisible();

  // Onaylı bordro varken puantaj ayı yeniden açılamaz
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await dialog.getByLabel('Gerekçe').fill('Eksik mesai girişi');
  await dialog.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await expect(dialog.getByText(/onaylanmış bordro var/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(page.getByText('Ay kapalı', { exact: true })).toBeVisible();

  // Ödemeyi geri al → iptal et (gerekçeli) → ay açılabilir
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('row', { name: /BRD-/ }).click();
  await page.getByRole('button', { name: 'Ödemeyi geri al' }).click();
  await dialog.getByLabel('Gerekçe').fill('Ödeme iade edildi');
  await dialog.getByRole('button', { name: 'Ödemeyi geri al' }).click();
  await expect(page.getByText('Onaylı', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bordroyu iptal et' }).click();
  await expect(dialog.getByRole('button', { name: 'Bordroyu iptal et' })).toBeDisabled();
  await dialog.getByLabel('Gerekçe').fill('Yanlış ay seçildi');
  await dialog.getByRole('button', { name: 'Bordroyu iptal et' }).click();
  await expect(page.getByText('İptal', { exact: true })).toBeVisible();
  await expect(page.getByText('Bordro iptal edildi (yevmiye ters çevrildi)')).toBeVisible();

  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await dialog.getByLabel('Gerekçe').fill('Eksik mesai girişi');
  await dialog.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await expect(page.getByText('Ay açık', { exact: true })).toBeVisible();
});
