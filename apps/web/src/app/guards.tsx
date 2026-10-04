import { LockKeyhole, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useLocation, useMatches } from 'react-router-dom';
import type { Permission } from '@erp/shared';
import { EmptyState, PageLoading } from '../components/ui/Feedback';
import { useNavigation } from '../lib/queries';
import { useSession } from '../lib/session';
import { Button } from '../components/ui/Button';

/** Girişten sonra dönülecek adres (sorgu ve çapa dahil: /invoices/new?type=purchase gibi derin bağlantılar korunur, UI-12). */
type FromState = { from?: string } | null;

/** Giriş yapılmamışsa /login'e yönlendirir; oturum geri yüklenirken bekler. */
export function RequireAuth() {
  const { status, user } = useSession();
  const location = useLocation();
  if (status === 'loading') return <div className="flex h-full items-center justify-center"><PageLoading /></div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  // Geçici parolayla girilmişse önce kendi parolasını seçmeli (sunucu da diğer uçları 403 ile kapatır)
  if (user?.mustChangePassword && location.pathname !== '/password-change') return <Navigate to="/password-change" replace />;
  return <Outlet />;
}

/** Güvenli iç adres mi (açık yönlendirmeye karşı: yalnızca "/" ile başlayan, "//" ile başlamayan yollar). */
const safeFrom = (from: unknown): string | null => (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : null);

/**
 * Giriş yapmış kullanıcı login/register'a gelirse yönlendirir. Girişten/kayıttan sonraki TEK yönlendirme buradadır
 * (sayfalar ayrıca navigate etmez): şirketi yoksa doğrudan kuruluma, varsa geldiği derin bağlantıya ya da ana sayfaya.
 * Önceden kayıt sayfasının kendi navigate'i ile buradaki "/" yönlendirmesi yarışıyor, kurulum sayfası iki kez
 * bağlanıp yazılan şirket unvanı siliniyordu (UI-21, e2e kararsızlığı).
 */
export function PublicOnly() {
  const { status, companies } = useSession();
  const location = useLocation();
  if (status === 'loading') return <div className="flex h-full items-center justify-center"><PageLoading /></div>;
  if (status === 'authenticated') {
    const from = safeFrom((location.state as FromState)?.from);
    return <Navigate to={companies.length === 0 ? '/company/new' : (from ?? '/')} replace />;
  }
  return <Outlet />;
}

/** Şirketi olmayan kullanıcıyı kuruluma yönlendirir. */
export function RequireCompany() {
  const { activeCompany } = useSession();
  if (!activeCompany) return <Navigate to="/company/new" replace />;
  return <Outlet />;
}

/** Modül şirkette etkin değilse sayfayı hiç göstermez (sunucu da 403 verir). */
export function RequireModule({ module }: { module: string }) {
  const { t } = useTranslation();
  const { data, isPending } = useNavigation();
  if (isPending) return <PageLoading />;
  if (!data?.modules.includes(module)) {
    return (
      <EmptyState
        icon={<LockKeyhole className="size-5" />}
        title={t('common.notAvailable')}
        action={
          <Link to="/">
            <Button variant="secondary">{t('nav.dashboard')}</Button>
          </Link>
        }
      />
    );
  }
  return <Outlet />;
}

/** Rota meta verisi: sayfanın ana API çağrısının istediği izin (menüdeki izinle aynı; `null` = herkese açık). */
export interface RouteHandle {
  permission: Permission | null;
}

/** "Bu sayfayı görme yetkiniz yok" ekranı (UI-7). */
export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <div data-testid="forbidden-page">
      <EmptyState
        icon={<ShieldOff className="size-5" />}
        title={t('common.forbiddenTitle')}
        description={t('common.forbiddenDesc')}
        action={
          <Link to="/">
            <Button variant="secondary">{t('common.goHome')}</Button>
          </Link>
        }
      />
    </div>
  );
}

/**
 * Rota düzeyinde izin kapısı (UI-7): eşleşen en derin rotanın `handle.permission` iznini rol taşımıyorsa sayfa hiç
 * çizilmez; sonsuz yükleniyor göstergesi ya da 403 arkasında "kayıt yok" boş durumu yerine açık bir yetki ekranı çıkar.
 * İzinler `/api/navigation`'dan gelir (menü ve komut paleti ile aynı kaynak); sunucu yine her uçta ayrıca denetler.
 */
export function RequireRoutePermission() {
  const matches = useMatches();
  const { data, isPending } = useNavigation();
  const handle = [...matches].reverse().find((m) => m.handle && typeof m.handle === 'object' && 'permission' in m.handle)?.handle as RouteHandle | undefined;
  const permission = handle?.permission ?? null;
  if (!permission) return <Outlet />;
  if (isPending) return <PageLoading />;
  if (!data?.permissions.includes(permission)) return <ForbiddenPage />;
  return <Outlet />;
}
