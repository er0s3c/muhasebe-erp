import { useEffect } from 'react';
import { formatDateTR, todayIso } from '@erp/shared';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Yazdırmadan hemen önce: (1) geniş tablo varsa A4 yatay, yoksa dikey; (2) sayfa altına şirket / "Sayfa X / Y" / tarih;
 * (3) belge başlığını sayfa başlığından üretir (tarayıcı "PDF olarak kaydet" dosya adı olarak kullanır). Sonra eski hâline döner.
 */
export function usePrintSetup(companyName: string) {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.printDynamic = '1';
    let prevTitle = '';
    const before = () => {
      const tables = [...document.querySelectorAll<HTMLTableElement>('main table')];
      const wide = tables.some((t) => t.querySelectorAll('thead th').length >= 8 || t.scrollWidth > 760);
      const h1 = document.querySelector('main h1')?.textContent?.trim();
      const foot = "font: 8pt 'Inter Variable', Arial, sans-serif; color: #6d6c6b;";
      style.textContent =
        `@page { size: A4 ${wide ? 'landscape' : 'portrait'}; margin: ${wide ? '11mm 10mm 15mm' : '14mm 12mm 16mm'};` +
        ` @bottom-left { content: "${esc(companyName)}"; ${foot} }` +
        ` @bottom-center { content: "Sayfa " counter(page) " / " counter(pages); ${foot} }` +
        ` @bottom-right { content: "${formatDateTR(todayIso())}"; ${foot} } }`;
      document.head.appendChild(style);
      prevTitle = document.title;
      if (h1) document.title = `${h1} – ${companyName} – ${todayIso()}`;
    };
    const after = () => {
      style.remove();
      if (prevTitle) document.title = prevTitle;
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      style.remove();
    };
  }, [companyName]);
}
