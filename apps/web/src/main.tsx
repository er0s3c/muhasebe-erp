import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installZodTurkish } from '@erp/shared';
import './i18n';
import './styles.css';
import { App } from './app/App';

// Form doğrulama iletileri Türkçe (paylaşılan şemalarla aynı; UI-11)
installZodTurkish();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
