import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

/** Belge sonu imza blokları (yalnızca basılı çıktıda): her etiket bir imza alanı. */
export function PrintSignatures({ labels }: { labels: readonly string[] }) {
  return (
    <div className="print-signatures print-only" style={{ '--cols': labels.length } as CSSProperties}>
      {labels.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

/** Belge altı küçük not (yalnızca basılı çıktıda): iç belge uyarısı vb. */
export function PrintNote({ children }: { children?: string }) {
  const { t } = useTranslation();
  return <p className="print-only mt-3 text-[8pt] text-[#55534f]">{children ?? t('reports.print.internalNote')}</p>;
}
