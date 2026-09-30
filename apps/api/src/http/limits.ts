import { AppError } from './errors';

/**
 * Bellek içi, süreç başına sabit pencereli sayaç. Tek uygulama örneği varsayar (çok örnekli barındırmada
 * paylaşılan bir depo gerekir; docs/OPERATIONS.md). `enabled=false` iken hiçbir şeyi engellemez (testler).
 */
export class MemoryLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly enabled: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  private live(key: string) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private sweep() {
    if (this.entries.size < 10_000) return;
    for (const [k, e] of this.entries) if (e.resetAt <= this.now()) this.entries.delete(k);
  }

  /** Sayacı artırır. Sınır aşıldıysa `ok:false` ve beklenecek saniyeyi döndürür. */
  consume(key: string, max: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
    if (!this.enabled) return { ok: true, retryAfterSec: 0 };
    this.sweep();
    const e = this.live(key);
    if (!e) {
      this.entries.set(key, { count: 1, resetAt: this.now() + windowMs });
      return { ok: true, retryAfterSec: 0 };
    }
    e.count += 1;
    if (e.count > max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000)) };
    return { ok: true, retryAfterSec: 0 };
  }

  /** Artırmadan bakar: sayaç `max`'a ulaştıysa beklenecek saniye, yoksa 0. */
  blocked(key: string, max: number): number {
    if (!this.enabled) return 0;
    const e = this.live(key);
    if (!e || e.count < max) return 0;
    return Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000));
  }

  /** Yalnızca başarısızlıkları saymak için: sayacı bir artırır (pencere ilk artışta başlar). */
  hit(key: string, windowMs: number): void {
    if (!this.enabled) return;
    this.sweep();
    const e = this.live(key);
    if (e) e.count += 1;
    else this.entries.set(key, { count: 1, resetAt: this.now() + windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}

/** Ekstre/defter türü raporların tek yanıtta döndürebileceği en çok satır (aşılırsa tarih aralığı daraltılır). */
let reportRowLimit = 20_000;
export const maxReportRows = () => reportRowLimit;
/** Yalnızca testler: tavanı küçültüp aşımı az veriyle sınamak için. */
export function setReportRowLimit(n: number): void {
  reportRowLimit = n;
}

/** Sorgu `MAX_REPORT_ROWS + 1` satır getirdiyse tavan aşılmıştır. */
export function assertReportSize(rowCount: number, hint = 'tarih aralığını daraltın'): void {
  if (rowCount > reportRowLimit) {
    throw new AppError(422, 'REPORT_TOO_LARGE', `Rapor ${reportRowLimit.toLocaleString('tr-TR')} satırdan büyük; ${hint}`);
  }
}

/**
 * Basit sayaçlı semafor: en çok `max` eş zamanlı iş; dolu iken `tryAcquire` false döner (bekletmez).
 * Bellek içi büyük dışa aktarmaların (tam veri, defter) süreci tıkamasını sınırlar.
 */
export class Semaphore {
  private held = 0;
  constructor(readonly max: number) {}

  tryAcquire(): boolean {
    if (this.held >= this.max) return false;
    this.held += 1;
    return true;
  }

  release(): void {
    this.held = Math.max(0, this.held - 1);
  }

  get busy(): number {
    return this.held;
  }
}
