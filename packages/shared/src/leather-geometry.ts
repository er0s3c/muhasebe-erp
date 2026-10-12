import { dec } from './money';

/** Normalize (0–1) koordinatlı nokta; parça çizimi ve kusur bölgeleri bu düzlemdedir. */
export interface NormPoint {
  x: number;
  y: number;
}
export interface DefectZone {
  code: string;
  kind: 'hole' | 'scratch' | 'tone' | 'other';
  points: NormPoint[];
}

/** Çokgen alanı (shoelace), normalize birimde. */
export function polygonArea(points: readonly NormPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Kusur bölgelerinin kullanım alanına etkisi (öneri 75). Delik her parçada kullanılamaz; çizik, ton ve diğer kusurlar yalnız
 * görünür (dış) parçalarda kullanılamaz, gizli (iç/astar) parçalarda kullanılabilir. Bölgeler parça çizimine oranlanır ve
 * örtüşme varsayılmaz (en kötü durum). Sonuç parçanın kayıtlı kullanılabilir alanını aşmaz.
 */
export function defectUsableAreas(input: { area: string; usableArea: string; outline?: readonly NormPoint[] | null; defects?: readonly DefectZone[] | null }) {
  const outlineArea = input.outline && input.outline.length >= 3 ? polygonArea(input.outline) : 1;
  const share = (kinds: DefectZone['kind'][]) =>
    Math.min(1, (input.defects ?? []).filter((d) => kinds.includes(d.kind)).reduce((s, d) => s + polygonArea(d.points), 0) / (outlineArea || 1));
  const area = dec(input.area);
  const usable = dec(input.usableArea);
  const cap = (fraction: number) => {
    const v = area.times(1 - fraction);
    return (v.lt(usable) ? v : usable).toDecimalPlaces(4);
  };
  return {
    hiddenUsable: cap(share(['hole'])).toFixed(4),
    visibleUsable: cap(share(['hole', 'scratch', 'tone', 'other'])).toFixed(4),
  };
}

/** Ton grubu anahtarı: büyük/küçük harf ve boşluk farkı aynı tondur; boş ton grupsuzdur. */
export const toneKey = (tone: string | null | undefined) => (tone ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');

/**
 * Dijital kalıp ölçek doğrulaması (öneri 73): kalıp alanı (m²) dış ölçü kutusuna (mm) sığmalı ve kutunun anlamlı bir kısmını
 * doldurmalı; mm/cm karışıklığı gibi ölçek hataları bu sınırlarla yakalanır.
 */
export function patternScaleIssue(areaM2: string, widthMm?: number, heightMm?: number): string | null {
  if (!widthMm || !heightMm) return null;
  const box = dec(widthMm).times(heightMm).div(1_000_000);
  const area = dec(areaM2);
  if (area.gt(box)) return `Kalıp alanı (${area.toFixed(4)} m²) dış ölçü kutusundan (${box.toFixed(4)} m²) büyük; ölçek hatası olabilir`;
  if (area.lt(box.times('0.2'))) return `Kalıp alanı (${area.toFixed(4)} m²) dış ölçü kutusunun %20'sinden küçük (${box.toFixed(4)} m²); ölçek hatası olabilir`;
  return null;
}
