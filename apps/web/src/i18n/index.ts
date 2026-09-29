import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import tr from './tr.json';

export const resources = { tr: { translation: tr } } as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'tr',
  fallbackLng: 'tr',
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Anahtar hatalarını derleme zamanında yakalamak için tipli kaynaklar
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof tr };
  }
}

export default i18n;
