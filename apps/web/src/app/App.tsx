import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { PageLoading } from '../components/ui/Feedback';
import { ToastProvider } from '../components/ui/Toast';
import { UnsavedChangesProvider } from '../components/ui/UnsavedChanges';
import { ActivationPage } from '../features/license/ActivationPage';
import { usePublicConfig } from '../lib/queries';
import { ApiError } from '../lib/api';
import { reportForbidden } from '../lib/forbidden';
import { SessionProvider } from '../lib/session';
import { router } from './router';

/**
 * Lisans kapısı: sunucu lisans denetimiyle çalışıyor ve kurulum henüz etkinleştirilmemişse (lisanssız) yönlendirici hiç
 * kurulmaz; yalnızca etkinleştirme sayfası gösterilir. Durum bilinmiyorsa (sunucuya ulaşılamıyor) uygulama normal açılır
 * ve kendi hata ekranlarını gösterir.
 */
function LicenseGate({ children }: { children: ReactNode }) {
  const { data, isPending } = usePublicConfig();
  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoading />
      </div>
    );
  }
  if (data?.license?.enforced && data.license.state === 'unlicensed') return <ActivationPage />;
  return <>{children}</>;
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Yetkisiz (403) yan sorgu: sayfa boş liste göstermesin, kabuk uyarı versin (UI-7)
        queryCache: new QueryCache({
          onError: (err, query) => {
            if (err instanceof ApiError && err.status === 403 && !query.meta?.allowForbidden) reportForbidden();
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // İstemci hatalarını (4xx) tekrar denemenin anlamı yok
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={150}>
      <LicenseGate>
        <SessionProvider>
          <ToastProvider>
            <UnsavedChangesProvider>
            <RouterProvider router={router} />
            </UnsavedChangesProvider>
          </ToastProvider>
        </SessionProvider>
      </LicenseGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
