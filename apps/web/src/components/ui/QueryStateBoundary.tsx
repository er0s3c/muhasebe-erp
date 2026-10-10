import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { ErrorState } from './Feedback';
import { QueryFeedbackContext } from './QueryFeedbackContext';

/** Never turn an active failed request into an empty list or an endless spinner. */
export function QueryStateBoundary({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [, update] = useReducer((value: number) => value + 1, 0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (['updated', 'observerAdded', 'observerRemoved'].includes(event.type)) update();
  }), [client]);
  const failed = client.getQueryCache().getAll().filter((query) => {
    const status = (query.state.error as { status?: number } | null)?.status;
    return query.getObserversCount() > 0 && query.state.status === 'error' && query.state.data === undefined &&
      status !== 401 && status !== 403;
  });
  return <QueryFeedbackContext.Provider value={failed.length > 0}>
    {failed.length > 0 && <div className="fixed bottom-4 right-4 z-[75] max-h-[70dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto print:hidden" data-testid="query-error-state">
      <ErrorState title="Bilgiler yüklenemedi" description="Bağlantıyı kontrol edip yeniden deneyin. Mevcut bilgileri düzenlemeye devam edebilirsiniz."
        retrying={retrying} onRetry={() => {
          setRetrying(true);
          void Promise.allSettled(failed.map((query) => client.refetchQueries({ queryKey: query.queryKey, exact: true })))
            .finally(() => setRetrying(false));
        }} />
    </div>}
    {children}
  </QueryFeedbackContext.Provider>;
}
