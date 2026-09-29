import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/layout/Brand';

/** Giriş/kayıt için ikiye bölünmüş düzen: solda düz koyu panel + değer önerisi, sağda beyaz kart içinde form. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation();
  const features = t('auth.features', { returnObjects: true }) as string[];

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="hidden flex-col justify-between bg-inverted p-12 text-on-inverted lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark className="size-9 border border-white/15" />
          <span className="text-lg">{t('app.name')}</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-heading-lg">{t('app.tagline')}</h2>
          <ul className="mt-10 flex flex-col gap-3.5">
            {features.map((f) => (
              <li key={f} className="flex items-center gap-3 text-[15px] text-inverted-muted">
                <span className="flex size-5 items-center justify-center rounded-md border border-white/20 text-on-inverted">
                  <Check className="size-3.5" aria-hidden />
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-caption uppercase tracking-[0.05em] text-inverted-muted">© {new Date().getFullYear()} {t('app.name')}</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 sm:p-8">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BrandMark />
            <span className="text-lg">{t('app.name')}</span>
          </div>
          <h1 className="text-heading">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-6 text-center text-sm text-muted">{footer}</div>
        </div>
      </main>
    </div>
  );
}
