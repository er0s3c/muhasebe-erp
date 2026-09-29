import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/layout/Brand';

/** Giriş/kayıt için ikiye bölünmüş düzen: solda değer önerisi, sağda form. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation();
  const features = t('auth.features', { returnObjects: true }) as string[];

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#0b2b2a] p-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(circle, #2dd4bf, transparent 70%)' }}
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <BrandMark className="size-9" />
          <span className="text-lg font-semibold tracking-tight">{t('app.name')}</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">{t('app.tagline')}</h2>
          <ul className="mt-8 flex flex-col gap-3.5">
            {features.map((f) => (
              <li key={f} className="flex items-center gap-3 text-[15px] text-white/85">
                <span className="flex size-5 items-center justify-center rounded-full bg-white/15">
                  <Check className="size-3.5" aria-hidden />
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">© {new Date().getFullYear()} {t('app.name')}</p>
      </aside>

      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BrandMark />
            <span className="text-lg font-semibold">{t('app.name')}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-6 text-center text-sm text-muted">{footer}</div>
        </div>
      </main>
    </div>
  );
}
