import type { FullConfig } from '@playwright/test';

/**
 * Üretim paketi modunda (E2E_TARGET=bundle) paket lisans denetimiyle derlenmiştir ve lisanssız açılır.
 * Burada önce kapının GERÇEKTEN kapalı olduğu doğrulanır (kimliksiz kayıt 402), sonra gerçek lisans sunucusundan
 * verilen kodla kurulum etkinleştirilir (lisans-server/tools/ci-license-host.sh E2E_LICENSE_CODE üretir). Geliştirme modunda lisans denetimi kapalıdır.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.E2E_TARGET !== 'bundle') return;
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';
  const json = { 'content-type': 'application/json' };

  const pub = (await (await fetch(`${base}/api/public-config`)).json()) as { license?: { enforced?: boolean; state?: string | null } };
  if (!pub.license?.enforced) throw new Error('Üretim paketi lisans denetimiyle derlenmemiş görünüyor (public-config license.enforced=false)');
  if (pub.license.state === 'active' || pub.license.state === 'grace') return; // önceki çalıştırmadan etkin

  if (pub.license.state !== 'unlicensed') {
    throw new Error(`Lisans durumu '${pub.license.state}': veritabanını sıfırlayın ya da sahip olarak yenileyin (npm run db:migrate, temiz bir veritabanı)`);
  }
  const blocked = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: json, body: '{}' });
  if (blocked.status !== 402) throw new Error(`Lisanssız kurulumda kayıt 402 vermeliydi, ${blocked.status} döndü`);

  const code = process.env.E2E_LICENSE_CODE;
  if (!code) throw new Error('E2E_LICENSE_CODE tanımlı değil (lisans-server/tools/ci-license-host.sh ile gerçek lisans sunucusu kurun)');
  const res = await fetch(`${base}/api/license/activate`, { method: 'POST', headers: json, body: JSON.stringify({ code }) });
  if (!res.ok) throw new Error(`Lisans etkinleştirilemedi (${res.status}): ${await res.text()}`);

  // Kurulum sahibi: ilk şirketi açan kuruluş kurulumun sahibi olur (lisans, güncelleme ve cihaz yönetimi ona aittir).
  // Diğer senaryolar şirket açmadan önce burada oluşturulur; lisans senaryoları bu hesapla girer (E2E_OWNER_*).
  const email = `e2e-kurulum-sahibi-${Date.now()}@example.com`;
  const password = 'Sifre-12345-xyz';
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, password, fullName: 'Kurulum Sahibi', organizationName: 'Kurulum Sahibi Ltd.' }),
  });
  if (reg.status !== 201) throw new Error(`Kurulum sahibi kaydı başarısız (${reg.status}): ${await reg.text()}`);
  const token = ((await reg.json()) as { accessToken: string }).accessToken;
  const company = await fetch(`${base}/api/companies`, {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Kurulum Sahibi İnşaat', sector: 'CONSTRUCTION' }),
  });
  if (company.status !== 201) throw new Error(`Kurulum sahibinin şirketi açılamadı (${company.status}): ${await company.text()}`);
  process.env.E2E_OWNER_EMAIL = email;
  process.env.E2E_OWNER_PASSWORD = password;
}
