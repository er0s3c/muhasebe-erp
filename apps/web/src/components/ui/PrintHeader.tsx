/**
 * Yalnızca yazdırırken görünen rapor süzgeç/dönem satırı. Şirket unvanı ve yazdırma tarihi AppShell'deki
 * `PrintLetterhead`'dedir; bu bileşen sayfa başlığının altına dönem/süzgeç bilgisini ekler.
 */
export function PrintHeader({ subtitle, note }: { subtitle?: string; note?: string }) {
  const text = [subtitle, note].filter(Boolean).join(' · ');
  if (!text) return null;
  return <p className="print-only -mt-4 mb-3 text-[9.5pt] text-[#55534f]">{text}</p>;
}
