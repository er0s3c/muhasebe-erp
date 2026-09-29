import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** Açık/koyu tema; tercih localStorage'da, yoksa sistem ayarı (index.html ilk boyamada uygular). */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* özel pencere */
    }
  }, []);

  return { theme, toggle };
}
