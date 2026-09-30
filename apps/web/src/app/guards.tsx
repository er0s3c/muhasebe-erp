import { LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { EmptyState, PageLoading } from '../components/ui/Feedback';
import { useNavigation } from '../lib/queries';
import { useSession } from '../lib/session';
import { Button } from '../components/ui/Button';

/** Giriş yapılmamışsa /login'e yönlendirir; oturum geri yüklenirken bekler. */
export function RequireAuth() {
  const { status, user } = useSession();
  const location = useLocation();
  if (status === 'loading') return <div className="flex h-full items-center justify-center"><PageLoading /></div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // Geçici parolayla girilmişse önce kendi parolasını seçmeli (sunucu da diğer uçları 403 ile kapatır)
  if (user?.mustChangePassword && location.pathname !== '/password-change') return <Navigate to="/password-change" replace />;
  return <Outlet />;
}

/** Giriş yapmış kullanıcı login/register'a gelirse ana sayfaya alır. */
export function PublicOnly() {
  const { status } = useSession();
  if (status === 'loading') return <div className="flex h-full items-center justify-center"><PageLoading /></div>;
  if (status === 'authenticated') return <Navigate to="/" replace />;
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
