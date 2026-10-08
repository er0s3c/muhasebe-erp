import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { all, fail, lockLeatherCosts, type LeatherCtx, type Row } from '../leather/common';
import { createRecord } from './service';

export async function command<T>(
  tx: Tx,
  ctx: LeatherCtx,
  name: string,
  input: Row & { requestKey: string },
  run: () => Promise<T>,
): Promise<T> {
  await lockLeatherCosts(tx, ctx.companyId);
  const hash = createHash('sha256').update(JSON.stringify({ name, input })).digest('hex');
  const prior = await all(
    tx,
    sql`select config from manufacturing_records where kind='command_event' and request_key=${input.requestKey}::uuid`,
  );
  if (prior.length) {
    if (prior[0]!.config.hash !== hash)
      throw fail(
        'İstek kimliği farklı komut içeriğinde kullanıldı',
        'MANUFACTURING_COMMAND_CONFLICT',
      );
    return prior[0]!.config.result as T;
  }
  const result = await run();
  await createRecord(
    tx,
    ctx,
    'command_event',
    {
      code: name + ':' + input.requestKey,
      requestKey: input.requestKey,
      hash,
      result,
      reason: input.reason,
    },
    'completed',
  );
  return result;
}
