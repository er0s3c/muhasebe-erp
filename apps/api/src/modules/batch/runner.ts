import type { Tx } from '../../db/client';
import { mapError } from '../../http/errors';

/**
 * Önizlemeli toplu işlem çalıştırıcısı (öneri 6). Her kayıt kendi savepoint'inde işlenir: bir kaydın hatası diğerlerini bozmaz
 * ve nedeniyle raporlanır. Önizlemede (`dryRun`) işlem gerçekten yapılır ve savepoint geri alınır; böylece önizleme, aynı iş
 * kurallarıyla (dönem, onay, stok, numara) gerçek sonucu gösterir ve hiçbir iz bırakmaz (boşluksuz numara sayacı da geri döner).
 */
export interface BatchItemResult<R> {
  id: string;
  ok: boolean;
  value?: R;
  error?: { code: string; message: string; details?: unknown };
}

class DryRunRollback<R> extends Error {
  constructor(readonly value: R) {
    super('dry-run');
  }
}

export async function runEach<R>(tx: Tx, ids: readonly string[], work: (sp: Tx, id: string) => Promise<R>, opts: { dryRun: boolean }): Promise<BatchItemResult<R>[]> {
  const results: BatchItemResult<R>[] = [];
  for (const id of ids) {
    try {
      const value = await tx.transaction(async (sp) => {
        const done = await work(sp, id);
        if (opts.dryRun) throw new DryRunRollback(done);
        return done;
      });
      results.push({ id, ok: true, value });
    } catch (cause) {
      if (cause instanceof DryRunRollback) {
        results.push({ id, ok: true, value: cause.value as R });
        continue;
      }
      const mapped = mapError(cause);
      // Beklenmeyen (eşlenmemiş) hata toplu işlemi durdurur: veritabanı durumu belirsiz olabilir
      if (!mapped) throw cause;
      results.push({ id, ok: false, error: { code: mapped.code, message: mapped.message, ...(mapped.details !== undefined ? { details: mapped.details } : {}) } });
    }
  }
  return results;
}
