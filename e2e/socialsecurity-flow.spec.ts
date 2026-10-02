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
 * Sosyal güvenlik çıktıları: personel + puantaj + ücret + (TEST) oranlar → bordro onayı → sosyal güvenlik profili (numara maskeli) ve
 * destek kuralı (varsayılan kapalı → açık) + uygunluk → bildirim üret (GENEL düzen, resmî değil notu) → kesinleştir → bordro iptali ve
 * puantaj ayı açma engellenir → bildirimi yeniden aç → prim özeti.
 */
test('sosyal güvenlik: profil → destek kuralı → bildirim → kesinleştir → kilitler → yeniden aç → prim özeti', async ({ page }) => {
  await signUpWithCompany(page, 'social');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const month = thisMonth();

  // Personel + puantaj
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

  // Bordro ayarları: iki test oranı (açık) ve ücret şartı
  await nav.getByRole('link', { name: 'Bordro ayarları' }).click();
  const paramForm = page.locator('form').filter({ has: page.getByLabel('Kaynak notu') });
  for (const [key, value] of [['employee_social_pct', '10'], ['employer_social_pct', '12']] as const) {
    await paramForm.getByLabel('Parametre', { exact: true }).selectOption(key);
    await paramForm.getByLabel(/^Değer/).fill(value);
    await paramForm.getByLabel('Yeni parametre açık').click();
    await paramForm.getByRole('button', { name: 'Ekle' }).click();
    await expect(page.getByText('Parametre eklendi')).toBeVisible();
    await expect(page.getByText('Parametre eklendi')).toBeHidden();
  }
  const termForm = page.locator('form').filter({ has: page.getByLabel('Ücret tutarı') });
  const empSelect = termForm.getByLabel('Personel', { exact: true });
  await empSelect.selectOption((await empSelect.locator('option', { hasText: 'Ali Demir' }).getAttribute('value'))!);
  await termForm.getByLabel('Ücret tutarı').fill('3000');
  await termForm.getByLabel('Geçerlilik başlangıcı').fill(`${month}-01`);
  await termForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Ücret şartı eklendi')).toBeVisible();

  // Puantajı kapat, bordroyu aç ve onayla
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı kapat' }).click();
  await dialog.getByRole('button', { name: 'Ayı kapat' }).click();
  await expect(page.getByText('Ay kapalı', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni bordro' }).first().click();
  await dialog.getByRole('button', { name: 'Bordro aç' }).click();
  await expect(page.getByRole('heading', { name: `${month} bordrosu`, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Onayla' }).click();
  await dialog.getByRole('button', { name: 'Onayla' }).click();
  await expect(page.getByText('Onaylı', { exact: true })).toBeVisible();

  // Sosyal güvenlik ayarları: profil (numara maskeli), destek kuralı (varsayılan kapalı), uygunluk
  await nav.getByRole('link', { name: 'Sosyal güvenlik ayarları' }).click();
  await expect(page.getByRole('heading', { name: 'Sosyal güvenlik ayarları', level: 1 })).toBeVisible();
  await expect(page.getByText('Henüz profil yok')).toBeVisible();
  await expect(page.getByText('Henüz kural yok: prim desteği uygulanmaz')).toBeVisible();
  const profileForm = page.locator('form').filter({ has: page.getByLabel('Bordro tipi kodu') });
  const pSelect = profileForm.getByLabel('Personel', { exact: true });
  await pSelect.selectOption((await pSelect.locator('option', { hasText: 'Ali Demir' }).getAttribute('value'))!);
  await profileForm.getByLabel('Bordro tipi kodu').fill('TEST-TIP-A');
  await profileForm.getByLabel('Sosyal güvenlik no').fill('12345678901');
  await profileForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Profil eklendi')).toBeVisible();
  const profileRow = page.getByRole('row', { name: /Ali Demir/ });
  await expect(profileRow).toContainText('••••8901');
  await expect(profileRow).toContainText('TEST-TIP-A');
  await expect(page.getByText('12345678901')).toHaveCount(0);
  // Açık görüntüleme: gerekçe ister
  await profileRow.getByRole('button', { name: 'Numarayı göster' }).click();
  await expect(dialog.getByRole('button', { name: 'Numarayı göster' })).toBeDisabled();
  await dialog.getByLabel('Gerekçe').fill('Bildirim doğrulaması');
  await dialog.getByRole('button', { name: 'Numarayı göster' }).click();
  await expect(profileRow).toContainText('12345678901');

  const ruleForm = page.locator('form').filter({ has: page.getByLabel('Hedef prim') });
  await ruleForm.getByLabel('Kod', { exact: true }).fill('TST1');
  await ruleForm.getByLabel('Ad', { exact: true }).fill('Test desteği');
  await ruleForm.getByLabel('Başlangıç', { exact: true }).fill(`${month}-01`);
  await ruleForm.getByLabel('Hedef prim').selectOption('employer');
  await ruleForm.getByLabel(/^Değer/).fill('50');
  await ruleForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Kural eklendi')).toBeVisible();
  const ruleRow = page.getByRole('row', { name: /TST1/ });
  await expect(ruleRow).toContainText('Doğrulanmadı');
  await page.getByLabel('TST1 kuralını aç/kapat', { exact: true }).click();
  await expect(page.getByLabel('TST1 kuralını aç/kapat', { exact: true })).toBeChecked();

  const eligForm = page.locator('form').filter({ has: page.getByLabel('Kural kodu') });
  const eSelect = eligForm.getByLabel('Personel', { exact: true });
  await eSelect.selectOption((await eSelect.locator('option', { hasText: 'Ali Demir' }).getAttribute('value'))!);
  await eligForm.getByLabel('Kural kodu').selectOption('TST1');
  await eligForm.getByLabel('Başlangıç', { exact: true }).fill(`${month}-01`);
  await eligForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Beyan eklendi')).toBeVisible();

  // Bildirim: GENEL düzen notu, numara maskeli, prim bordrodan, destek yalnızca kural açık + uygunluk beyanı varken
  await nav.getByRole('link', { name: 'Sosyal güvenlik', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sosyal güvenlik çıktıları', level: 1 })).toBeVisible();
  await expect(page.getByText(/resmî bildirim formatı değildir, doğrulanmadı/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Yeni bildirim' }).first().click();
  await dialog.getByRole('button', { name: 'Bildirim üret' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`${month}`);
  await expect(page.getByText('Taslak', { exact: true })).toBeVisible();
  const row = page.getByRole('row', { name: /Ali Demir/ });
  await expect(row).toContainText('••••8901');
  await expect(row).toContainText('TEST-TIP-A');
  await expect(row).toContainText('3.000,00');
  await expect(row).toContainText('300,00');
  await expect(row).toContainText('360,00');
  await expect(row).toContainText('180,00 (TST1)');
  await expect(page.getByText('12345678901')).toHaveCount(0);
  await expect(page.getByText(/Doğrulanmadı/).first()).toBeVisible();

  // Kesinleştir
  await page.getByRole('button', { name: 'Kesinleştir' }).click();
  await dialog.getByRole('button', { name: 'Kesinleştir' }).click();
  await expect(page.getByText('Kesinleşmiş', { exact: true })).toBeVisible();
  await expect(page.getByText(/bordro iptal edilemez ve puantaj ayı açılamaz/)).toBeVisible();

  // Kilitler: bordro iptali ve puantaj ayı açma engellenir
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('row', { name: /BRD-/ }).click();
  await page.getByRole('button', { name: 'Bordroyu iptal et' }).click();
  await dialog.getByLabel('Gerekçe').fill('Düzeltme gerekli');
  await dialog.getByRole('button', { name: 'Bordroyu iptal et' }).click();
  await expect(dialog.getByText(/sosyal güvenlik bildirimi/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await dialog.getByLabel('Gerekçe').fill('Eksik mesai girişi');
  await dialog.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await expect(dialog.getByText(/sosyal güvenlik bildirimi/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();

  // Prim özeti (kesinleşmiş): aya ve projeye göre
  await nav.getByRole('link', { name: 'Sosyal güvenlik', exact: true }).click();
  await page.getByRole('tab', { name: 'Prim özeti' }).click();
  await expect(page.getByRole('heading', { name: 'Aya göre' })).toBeVisible();
  await expect(page.getByRole('row', { name: /SGB-/ })).toContainText('Kesinleşmiş');
  await expect(page.getByRole('heading', { name: 'Projeye göre' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Etiketsiz/ })).toContainText('300,00');

  // Yeniden aç (gerekçeli) → taslak
  await page.getByRole('tab', { name: 'Aylık bildirimler' }).click();
  await page.getByRole('row', { name: /SGB-/ }).click();
  await page.getByRole('button', { name: 'Yeniden aç' }).click();
  await expect(dialog.getByRole('button', { name: 'Yeniden aç' })).toBeDisabled();
  await dialog.getByLabel('Gerekçe').fill('Prim düzeltmesi');
  await dialog.getByRole('button', { name: 'Yeniden aç' }).click();
  await expect(page.getByText('Taslak', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 kez yeniden açıldı/)).toBeVisible();
});
