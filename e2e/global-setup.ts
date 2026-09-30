import type { FullConfig } from '@playwright/test';

/**
 * Üretim paketi modunda (E2E_TARGET=bundle) paket lisans denetimiyle derlenmiştir ve lisanssız açılır.
 * Burada önce kapının GERÇEKTEN kapalı olduğu doğrulanır (kimliksiz kayıt 402), sonra gerçek lisans sunucusundan
 * verilen kodla kurulum etkinleştirilir (scripts/ci-license-host.sh E2E_LICENSE_CODE üretir). Geliştirme modunda lisans denetimi kapalıdır.
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
  if (!code) throw new Error('E2E_LICENSE_CODE tanımlı değil (scripts/ci-license-host.sh ile gerçek lisans sunucusu kurun)');
  const res = await fetch(`${base}/api/license/activate`, { method: 'POST', headers: json, body: JSON.stringify({ code }) });
  if (!res.ok) throw new Error(`Lisans etkinleştirilemedi (${res.status}): ${await res.text()}`);
}
