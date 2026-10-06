import type { FastifyRequest } from 'fastify';
import { AppError } from '../http/errors';
import type { LicenseReason, LicenseService, LicenseSnapshot } from './service';

/** Lisanssız kurulumda yalnızca bunlar açıktır (etkinleştirme akışı ve altyapı yoklamaları). */
const OPEN_WHEN_UNLICENSED = new Set(['GET /api/health', 'GET /api/health/ready', 'GET /api/public-config']);

/**
 * Salt-okunur modda yine de yapılabilen yazma istekleri: kimlik doğrulama (kullanıcılar girip — iki adımlı doğrulama dahil —
 * verilerini görebilsin, parolasını sıfırlayabilsin), güncelleyici bildirimi ve lisans uçları (yenileme/yeniden etkinleştirme).
 */
const WRITES_WHEN_RESTRICTED = new Set([
  'POST /api/auth/login',
  'POST /api/auth/mfa/verify',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/auth/change-password',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'POST /api/auth/verify-email',
  'POST /api/auth/resend-verification',
  // Yerel güncelleyicinin durum bildirimi (paylaşılan belirteçle): salt-okunurken de güncelleme sonucu yazılabilmeli,
  // yoksa başarısız güncelleme "istendi" durumunda kalır ve her dakika yeniden denenir.
  'POST /api/system/updater/report',
  'POST /api/system/updater/offline',
]);

const isLicenseRoute = (route: string) => route === '/api/license' || route.startsWith('/api/license/');
/** Cihaz yönetimi salt-okunurken de açıktır: yönetici koltuk boşaltıp girişi yeniden açabilmeli. */
const isDeviceRoute = (route: string) => route === '/api/devices' || route.startsWith('/api/devices/');

const REASON_MESSAGES: Record<LicenseReason, string> = {
  expired: 'Lisans süreniz doldu; yalnızca görüntüleme ve dışa aktarma yapılabilir. Yenilemek için satıcınızla iletişime geçin.',
  revoked: 'Lisansınız iptal edilmiş; yalnızca görüntüleme ve dışa aktarma yapılabilir. Satıcınızla iletişime geçin.',
  suspended: 'Lisansınız askıya alınmış; yalnızca görüntüleme ve dışa aktarma yapılabilir. Satıcınızla iletişime geçin.',
  fingerprint_mismatch: 'Lisans bu sunucuya ait değil (sunucu değişmiş olabilir); yalnızca görüntüleme ve dışa aktarma yapılabilir. Lisansı bu sunucuda yeniden etkinleştirin.',
  installation_mismatch: 'Lisans bu kuruluma ait değil; yalnızca görüntüleme ve dışa aktarma yapılabilir. Lisansı yeniden etkinleştirin.',
  clock_rollback: 'Lisans zamanı doğrulanamıyor; internete bağlanıp lisansı yeniden doğrulayın. Bu sürede görüntüleme, yedekleme ve dışa aktarma açıktır.',
  invalid_lease: 'Lisans kaydı doğrulanamadı; yalnızca görüntüleme ve dışa aktarma yapılabilir. Lisansı yenileyin ya da yeniden etkinleştirin.',
};

export const restrictionMessage = (reason: LicenseReason | undefined): string =>
  (reason && REASON_MESSAGES[reason]) || 'Lisans kısıtlı; yalnızca görüntüleme ve dışa aktarma yapılabilir.';

/**
 * İstek mevcut lisans durumunda yapılabilir mi? Yapılamıyorsa gönderilecek hatayı döndürür.
 * `route`, Fastify'ın eşleştirdiği rota deseni (örn. `/api/invoices/:id`); `/api/` dışındakiler (web arayüzü dosyaları)
 * ve eşleşmeyen yollar (404) her zaman geçer: arayüz, etkinleştirme sayfasını gösterebilmek için yüklenebilmelidir.
 */
export function checkRequest(snap: LicenseSnapshot, method: string, route: string | undefined): AppError | null {
  if (!snap.enforced) return null;
  if (!route || !route.startsWith('/api/')) return null;
  if (snap.state === 'active' || snap.state === 'grace') return null;

  const m = method.toUpperCase();
  const key = `${m} ${route}`;
  if (snap.state === 'unlicensed') {
    if (OPEN_WHEN_UNLICENSED.has(key) || isLicenseRoute(route)) return null;
    return new AppError(402, 'LICENSE_REQUIRED', 'Bu kurulumun lisansı etkinleştirilmemiş; devam etmek için lisansınızı etkinleştirin', {
      state: snap.state,
    });
  }
  // Salt-okunur (restricted): okuma serbest, yazma yalnızca kimlik doğrulama ve lisans uçlarında.
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  if (key === 'POST /api/settings/backups') return null;
  if (WRITES_WHEN_RESTRICTED.has(key) || isLicenseRoute(route) || isDeviceRoute(route)) return null;
  return new AppError(402, 'LICENSE_RESTRICTED', restrictionMessage(snap.reason), { state: snap.state, reason: snap.reason });
}

type RequestLike = Pick<FastifyRequest, 'method' | 'routeOptions'>;

/**
 * Lisans kapısı. Birbirinden bağımsız birkaç yerde çağrılır (genel `onRequest` kancası, `authedRoute`, `tenantRoute`);
 * denetim kapalıyken (geliştirme/test) hiçbir şey yapmaz.
 */
export async function assertLicensed(license: LicenseService, req: RequestLike): Promise<LicenseSnapshot | null> {
  if (!license.enforced) return null;
  const snap = await license.current();
  const err = checkRequest(snap, req.method, req.routeOptions?.url);
  if (err) throw err;
  return snap;
}
