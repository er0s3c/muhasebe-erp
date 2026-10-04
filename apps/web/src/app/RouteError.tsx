import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { NotFoundPage } from '../features/NotFoundPage';

/** Tembel yüklenen sayfa parçası (chunk) inemedi: genelde yeni sürüm yayımlandı ya da bağlantı koptu. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload CSS|Loading (CSS )?chunk \S+ failed/i.test(msg);
}

const RELOAD_KEY = 'chunkReloadAt';

/** Aynı parça hatasında en fazla bir kez (60 sn içinde) kendiliğinden yeniler; döngüye girmez. */
function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Rota hata sınırı (UI-4): React Router'ın geliştirici ekranı ("Unexpected Application Error") yerine Türkçe bir
 * sayfa gösterir. Parça yükleme hatasında önce bir kez kendiliğinden yeniler, olmazsa "Yeni sürüm yüklendi" der.
 */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const chunk = isChunkLoadError(error);

  useEffect(() => {
    if (chunk) reloadOnce();
    else console.error(error);
  }, [chunk, error]);

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  const detail = error instanceof Error ? error.message : isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : null;
  return (
    <div role="alert" data-testid="route-error" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-text">
        {chunk ? <RefreshCw className="size-5" aria-hidden /> : <AlertTriangle className="size-5" aria-hidden />}
      </div>
      <h1 className="text-subheading">{chunk ? t('errorPage.chunkTitle') : t('errorPage.title')}</h1>
      <p className="text-sm text-muted">{chunk ? t('errorPage.chunkDesc') : t('errorPage.desc')}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t('errorPage.reload')}
        </Button>
        <Link to="/" reloadDocument>
          <Button>{t('errorPage.home')}</Button>
        </Link>
      </div>
      {detail && !chunk && (
        <details className="mt-4 max-w-full text-left text-xs text-muted">
          <summary className="cursor-pointer">{t('errorPage.details')}</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">{detail}</pre>
        </details>
      )}
    </div>
  );
}
