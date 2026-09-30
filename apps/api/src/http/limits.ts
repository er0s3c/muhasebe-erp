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
