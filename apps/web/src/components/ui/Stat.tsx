import type { ReactNode } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { SectionHelp } from '../layout/PageHelpTooltip';
import { Card } from './Card';

export interface StatTrend {
  /** Önceki döneme göre yüzde değişim; hesaplanamıyorsa trend verilmez (tahmin çizilmez). */
  percent: number;
  /** Artış iyi mi (ciro) yoksa kötü mü (gider, gecikmiş alacak)? Renk buna göre seçilir. */
  goodWhen?: 'up' | 'down';
  label?: string;
}

/**
 * Gösterge kartı (KPI): sönük etiket, iri tek ağırlıklı değer, isteğe bağlı alt not, trend ve mini çizgi.
 * Değer yoksa kart değer uydurmaz; çağıran "—" veya açıklama verir.
 */
export function Stat({
  label,
  children,
  sub,
  className,
  trend,
  spark,
  icon,
  to,
  help,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  className?: string;
  trend?: StatTrend;
  /** Kronolojik sayı dizisi (en az 2 nokta). */
  spark?: number[];
  icon?: ReactNode;
  /** Kartın tamamı ilgili listeye gider. */
  to?: string;
  help?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
          {icon && <span className="shrink-0 text-muted [&>svg]:size-4" aria-hidden>{icon}</span>}
          <span className="min-w-0 break-words">{label}</span>
        </p>
        {help && <SectionHelp title={label} help={help} className="relative z-[1]" />}
      </div>
      <p className="mt-1.5 text-[clamp(1rem,10cqw,1.75rem)] font-semibold leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere]">{children}</p>
      {(trend || spark) && (
        <div className="mt-2 flex min-w-0 items-end justify-between gap-2">
          {trend ? <TrendPill trend={trend} /> : <span />}
          {spark && spark.length > 1 && <Sparkline values={spark} className="h-8 w-24 min-w-0 max-w-[45%]" />}
        </div>
      )}
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
    </>
  );
  return (
    <Card
      className={cn(
        'relative p-4 sm:p-5 [container-type:inline-size]',
        to && 'transition-colors hover:border-border-strong focus-within:border-border-strong',
        className,
      )}
    >
      {body}
      {to && (
        <Link to={to} className="absolute inset-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`${label} ayrıntıları`} />
      )}
    </Card>
  );
}

export function TrendPill({ trend }: { trend: StatTrend }) {
  const up = trend.percent > 0;
  const flat = Math.abs(trend.percent) < 0.05;
  const good = flat ? null : (trend.goodWhen ?? 'up') === 'up' ? up : !up;
  const Icon = up ? TrendingUp : TrendingDown;
  const value = `${up ? '+' : flat ? '' : '−'}${Math.abs(trend.percent).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}%`;
  return (
    <span
      title={trend.label ? `${value} ${trend.label}` : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium',
        good === null ? 'bg-surface-2 text-muted' : good ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
    >
      {!flat && <Icon className="size-3.5" aria-hidden />}
      <span>{value}</span>
      {/* Dar kartta taşmasın: açıklama yalnız ekran okuyucuya ve ipucuna */}
      {trend.label && <span className="sr-only">{trend.label}</span>}
    </span>
  );
}

/** Bağımlılıksız SVG mini çizgi; ekran okuyucuya ilk/son değer özetlenir. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 96;
  const h = 32;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => [i * step, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${d} L${w} ${h} L0 ${h} Z`;
  const last = points[points.length - 1]!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('overflow-visible text-text', className)} role="img" aria-label={`Eğilim: ${values[0]} → ${values[values.length - 1]}`}>
      <path d={area} className="fill-brand/30" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-current" />
    </svg>
  );
}
