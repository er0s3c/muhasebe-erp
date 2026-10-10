import { expect, type Page } from '@playwright/test';

/** Test kuralının çalışan grubu; kural ve vergi profili listelerinde bu adla bulunur. */
export const TEST_REGIME = 'E2E özel sektör (test)';

/**
 * Ülkesi KKTC olan şirkette bordro ülke motoruyla hesaplanır: tarihli kural kaydedilir, doğrulanır, etkinleştirilir ve her
 * personele vergi profili verilir. Değerler YALNIZCA TEST AMAÇLIDIR, resmî oran değildir. Yıllık kişisel indirim (önerilen
 * 655.000) küçük test ücretlerinde gelir vergisini sıfırlar; böylece net = brüt − sigorta işçi primi olur.
 * Sayfa "İK ve bordro ayarları › Bordro" sekmesinde olmalıdır.
 */
export async function setupKktcPayroll(page: Page, options: {
  month: string;
  employees: readonly string[];
  employeeInsurancePct: string;
  employerInsurancePct: string;
}) {
  const { month } = options;
  const ruleForm = page.locator('form').filter({ has: page.getByLabel('Sosyal sigorta rejimi / çalışan grubu') });
  await expect(ruleForm.getByLabel('Ülke', { exact: true })).toHaveValue('KKTC');
  await ruleForm.getByLabel('Yürürlük başlangıcı (ayın ilk günü)').fill(`${month}-01`);
  await ruleForm.getByLabel('Vergi yılı').fill(month.slice(0, 4));
  await ruleForm.getByLabel('Kural sürümü').fill('E2E-TEST-KKTC-v1');
  await ruleForm.getByLabel('Sosyal sigorta rejimi / çalışan grubu').fill(TEST_REGIME);
  for (const [label, value] of [
    ['Sigorta işçi (%)', options.employeeInsurancePct],
    ['Sigorta işveren (%)', options.employerInsurancePct],
    ['İş kazası ve meslek hastalığı (%)', '0'],
    ['İhtiyat işçi (%)', '0'],
    ['İhtiyat işveren (%)', '0'],
    ['Yerel istihdam katkısı işveren (%)', '0'],
    ['Aylık sigorta tabanı', '0'],
  ] as const) await ruleForm.getByLabel(label, { exact: true }).fill(value);
  await ruleForm.getByLabel('Kaynak ve uygunluk notu').fill('Uçtan uca test değerleri; resmî oran değildir');
  await ruleForm.getByRole('button', { name: 'Yeni tarihli kuralı kaydet' }).click();

  const rule = page.getByRole('table', { name: 'Ülke bordro kural sürümleri' }).getByRole('row', { name: new RegExp(TEST_REGIME.replace(/[()]/g, '\\$&')) });
  await expect(rule).toContainText('Doğrulanmadı');
  await expect(rule.getByRole('button', { name: 'Etkinleştir' })).toBeDisabled();
  await rule.getByRole('button', { name: 'Doğrula', exact: true }).click();
  const verify = page.getByRole('dialog', { name: 'Bordro kuralını doğrula' });
  await verify.getByRole('checkbox').check();
  await verify.getByRole('button', { name: 'Doğrulamayı kaydet' }).click();
  await expect(rule).toContainText('Doğrulandı');
  await rule.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(rule).toContainText('Etkin');

  const profileForm = page.locator('form').filter({ has: page.getByLabel('Ülke ve çalışan rejimi') });
  const profiles = page.getByRole('table', { name: 'Personel vergi profilleri' });
  for (const name of options.employees) {
    const employee = profileForm.getByLabel('Personel', { exact: true });
    await employee.selectOption((await employee.locator('option', { hasText: name }).getAttribute('value'))!);
    const config = profileForm.getByLabel('Ülke ve çalışan rejimi');
    await config.selectOption((await config.locator('option', { hasText: TEST_REGIME }).getAttribute('value'))!);
    await profileForm.getByLabel('Profil yürürlük tarihi').fill(`${month}-01`);
    await profileForm.getByLabel('Devreden vergi matrahı (yoksa 0)').fill('0');
    await profileForm.getByLabel('Devreden asgari ücret istisna matrahı (yoksa 0)').fill('0');
    await profileForm.getByRole('button', { name: 'Tarihli profili kaydet' }).click();
    await expect(profiles.getByRole('row', { name: new RegExp(name) })).toContainText(`KKTC / ${TEST_REGIME}`);
  }
}
