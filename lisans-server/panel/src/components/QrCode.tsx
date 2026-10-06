import { useMemo } from 'react';
import { encode } from 'uqr';

/** QR kodu (satır içi SVG; dış istek yok). Tema ne olursa olsun okunabilsin diye her zaman beyaz zemin üzerinde siyah. */
export function QrCode({ value, label, size = 184 }: { value: string; label: string; size?: number }) {
  const { path, dim } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, dim: qr.size };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" className="rounded-lg border border-border">
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
