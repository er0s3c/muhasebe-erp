import { isZero, money, moneyIn } from '../../lib/format';

/** Bakiye (borç − alacak): "1.250,00 B" (borçlu: bize borçlu) / "300,00 A" (alacaklı: bizim borcumuz). */
export function BalanceText({ value, currency }: { value: string; currency?: string }) {
  const fmt = (v: string) => (currency ? moneyIn(v, currency) : money(v));
  if (isZero(value)) return <span className="text-muted">{fmt('0')}</span>;
  const n = Number(value);
  return (
    <span title={n > 0 ? 'Borçlu (bize borçlu)' : 'Alacaklı (bizim borcumuz)'}>
      {fmt(String(Math.abs(n)))} <span className="text-xs text-muted">{n > 0 ? 'B' : 'A'}</span>
    </span>
  );
}
