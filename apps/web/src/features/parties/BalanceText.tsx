import { isZero, money } from '../../lib/format';

/** Bakiye (borç − alacak): "1.250,00 B" (borçlu: bize borçlu) / "300,00 A" (alacaklı: bizim borcumuz). */
export function BalanceText({ value }: { value: string }) {
  if (isZero(value)) return <span className="text-muted">0,00</span>;
  const n = Number(value);
  return (
    <span title={n > 0 ? 'Borçlu (bize borçlu)' : 'Alacaklı (bizim borcumuz)'}>
      {money(String(Math.abs(n)))} <span className="text-xs text-muted">{n > 0 ? 'B' : 'A'}</span>
    </span>
  );
}
