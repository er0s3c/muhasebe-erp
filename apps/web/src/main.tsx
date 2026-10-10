import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installZodTurkish } from '@erp/shared';
import './i18n';
import './styles.css';
import { App } from './app/App';

// Form doğrulama iletileri Türkçe (paylaşılan şemalarla aynı; UI-11)
installZodTurkish();

// Genel uygulama ve saha paketi aynı worker'ı kullanır; API yanıtları önbelleğe alınmaz.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/field-sw.js').catch(() => undefined); }, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
