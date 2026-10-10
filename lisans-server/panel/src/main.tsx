import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@ui/Toast';
import { UnsavedChangesProvider } from '@ui/UnsavedChanges';
import { App } from './App';
import { ApiError } from './api';
import '../../../apps/web/src/i18n';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <UnsavedChangesProvider><App /></UnsavedChangesProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
