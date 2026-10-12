import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import {
  fixedAssetSchema,
  depreciationForMonth,
  assetDisposalSchema,
  disposalResult,
  missingDepreciationMonths,
  idParam,
  todayIso,
  isoDate,
  dec,
  type FixedAssetInput,
  type CurrencyCode,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, notFound, unprocessable } from '../../http/errors';
import { validateDimensions } from '../projects/dimension';
import { createJournalEntry, reverseJournalEntry } from '../ledger/journal';

const read = { module: 'core.ledger', permission: 'ledger.read' } as const;
const write = { module: 'core.ledger', permission: 'ledger.post' } as const;
const monthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
type Row = {
  id: string;
  config: FixedAssetInput;
  version: number;
  active: boolean;
  historyCount: number;
  postedAmount: string;
  draftAmount: string;
  disposedOn: string | null;
} & Record<string, unknown>;
const fields = sql`a.id,a.config,a.version,a.active,a.created_at as "createdAt",
  coalesce((select sum(d.amount::numeric) from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.asset_id=a.id and d.cancelled_at is null and j.status='posted' and j.reversed_by_id is null),0)::text as "postedAmount",
  coalesce((select sum(d.amount::numeric) from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.asset_id=a.id and d.cancelled_at is null and j.status='draft'),0)::text as "draftAmount",
  (select count(*)::int from asset_depreciation d where d.asset_id=a.id) as "historyCount",
  (select x.disposal_date::text from asset_disposals x where x.asset_id=a.id and x.cancelled_at is null) as "disposedOn"`;
async function asset(c: TenantCtx, id: string, lock = false) {
  const row = (
    await c.tx.execute<Row>(
      sql`select ${fields} from fixed_assets a where a.id=${id}::uuid ${lock ? sql`for update` : sql``}`,
    )
  ).rows[0];
  if (!row) throw notFound('Demirbaş');
  return { ...row, bookValue: dec(row.config.cost).minus(String(row.postedAmount)).toFixed(2) };
}
async function validate(c: TenantCtx, input: FixedAssetInput) {
  const rows = (
    await c.tx.execute<{
      id: string;
      type: string;
      is_postable: boolean;
      is_active: boolean;
      party_control: string | null;
      currency_code: string | null;
    }>(
      sql`select id,type,is_postable,is_active,party_control,currency_code from accounts where id in (${input.expenseAccountId}::uuid,${input.accumulatedAccountId}::uuid)`,
    )
  ).rows;
  const expense = rows.find((a) => a.id === input.expenseAccountId),
    accumulated = rows.find((a) => a.id === input.accumulatedAccountId);
  if (
    !expense ||
    !accumulated ||
    !['expense', 'cost', 'income'].includes(expense.type) ||
    accumulated.type !== 'asset'
  )
    throw badRequest('Gider/maliyet hesabı ve varlık türünde birikmiş amortisman hesabı seçin.');
  if (
    rows.some(
      (a) =>
        !a.is_postable ||
        !a.is_active ||
        a.party_control ||
        (a.currency_code && a.currency_code !== c.company.baseCurrency),
    )
  )
    throw badRequest(
      'Hesaplar aktif, kayıt atılabilir, carisiz ve defter para birimiyle uyumlu olmalı.',
    );
  await validateDimensions(c.tx, c.company.id, [
    { label: 'Demirbaş', projectId: input.projectId, accountType: expense.type },
  ]);
}
const historyFields = sql`d.id,d.month,d.amount,d.snapshot,d.journal_entry_id as "journalEntryId",d.reversal_entry_id as "reversalEntryId",d.cancelled_at as "cancelledAt",d.cancel_reason as "cancelReason",d.created_at as "createdAt",j.status as "entryStatus",j.entry_no as "entryNo",j.entry_date::text as "entryDate"`;
async function history(c: TenantCtx, id: string) {
  return (
    await c.tx.execute(
      sql`select ${historyFields} from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.asset_id=${id}::uuid order by d.month desc,d.created_at desc limit 600`,
    )
  ).rows;
}
const disposalFields = sql`x.id,x.disposal_date::text as "disposalDate",x.method,x.proceeds,x.cost,x.accumulated,x.book_value as "bookValue",x.gain_loss as "gainLoss",x.note,x.journal_entry_id as "journalEntryId",x.reversal_entry_id as "reversalEntryId",x.cancelled_at as "cancelledAt",x.cancel_reason as "cancelReason",x.created_at as "createdAt"`;
async function disposals(c: TenantCtx, id: string) {
  return (await c.tx.execute(sql`select ${disposalFields} from asset_disposals x where x.asset_id=${id}::uuid order by x.created_at desc`)).rows;
}
/** Elden çıkarma hesapları: aktif, kayıt atılabilir, carisiz, defter para birimli ve beklenen türde olmalı. */
async function validateDisposalAccounts(c: TenantCtx, wanted: { id: string | null; types: string[]; label: string }[]) {
  const ids = wanted.map((w) => w.id).filter((v): v is string => !!v);
  if (!ids.length) return;
  const rows = (
    await c.tx.execute<{ id: string; type: string; is_postable: boolean; is_active: boolean; party_control: string | null; currency_code: string | null }>(
      sql`select id,type,is_postable,is_active,party_control,currency_code from accounts where id in (${sql.join(ids.map((v) => sql`${v}::uuid`), sql`,`)})`,
    )
  ).rows;
  for (const w of wanted) {
    if (!w.id) continue;
    const a = rows.find((r) => r.id === w.id);
    if (!a || !w.types.includes(a.type))
      throw badRequest(`${w.label} için uygun türde hesap seçin.`, 'ASSET_DISPOSAL_ACCOUNT');
    if (!a.is_postable || !a.is_active || a.party_control || (a.currency_code && a.currency_code !== c.company.baseCurrency))
      throw badRequest(`${w.label} aktif, kayıt atılabilir, carisiz ve defter para birimiyle uyumlu olmalı.`, 'ASSET_DISPOSAL_ACCOUNT');
  }
}
const ledgerCtx = (c: TenantCtx) => ({
  companyId: c.company.id,
  userId: c.user.id,
  baseCurrency: c.company.baseCurrency,
  reportingCurrency: c.company.reportingCurrency,
});
export const fixedAssetRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/fixed-assets',
    tenantRoute(app, read, async (c) => {
      const rows = (
        await c.tx.execute<Row>(
          sql`select ${fields} from fixed_assets a order by active desc,code limit 1001`,
        )
      ).rows;
      return {
        items: rows
          .slice(0, 1000)
          .map((r) => ({
            ...r,
            bookValue: dec(r.config.cost).minus(String(r.postedAmount)).toFixed(2),
          })),
        truncated: rows.length > 1000,
      };
    }),
  );
  app.post(
    '/api/fixed-assets',
    tenantRoute(app, write, async (c) => {
      const input = fixedAssetSchema.parse(c.req.body);
      await validate(c, input);
      const id = uuidv7();
      await c.tx.execute(
        sql`insert into fixed_assets(id,company_id,code,config,created_by) values(${id},${c.company.id},${input.code},${JSON.stringify(input)}::jsonb,${c.user.id})`,
      );
      void c.reply.code(201);
      return { asset: await asset(c, id) };
    }),
  );
  app.put(
    '/api/fixed-assets/:id',
    tenantRoute(app, write, async (c) => {
      const id = idParam.parse(c.req.params).id,
        { config, version } = z
          .object({ config: fixedAssetSchema, version: z.number().int().positive() })
          .parse(c.req.body);
      const row = await asset(c, id, true);
      if (row.version !== version)
        throw conflict('Kart başka biri tarafından değiştirildi; yenileyin.');
      if (Number(row.historyCount))
        throw conflict('Amortisman geçmişi bulunan kartın mali bilgileri değiştirilemez.');
      await validate(c, config);
      await c.tx.execute(
        sql`update fixed_assets set config=${JSON.stringify(config)}::jsonb,code=${config.code},version=version+1,updated_at=now() where id=${id}::uuid`,
      );
      return { asset: await asset(c, id) };
    }),
  );
  app.patch(
    '/api/fixed-assets/:id/active',
    tenantRoute(app, write, async (c) => {
      const id = idParam.parse(c.req.params).id,
        { active, version } = z
          .object({ active: z.boolean(), version: z.number().int().positive() })
          .parse(c.req.body);
      const row = await asset(c, id, true);
      if (row.version !== version)
        throw conflict('Kart başka biri tarafından değiştirildi; yenileyin.');
      if (active && row.disposedOn)
        throw conflict('Elden çıkarılmış demirbaş etkinleştirilemez; önce elden çıkarmayı iptal edin.', 'ASSET_DISPOSED');
      await c.tx.execute(
        sql`update fixed_assets set active=${active},version=version+1,updated_at=now() where id=${id}::uuid`,
      );
      return { asset: await asset(c, id) };
    }),
  );
  app.get(
    '/api/fixed-assets/:id',
    tenantRoute(app, read, async (c) => {
      const id = idParam.parse(c.req.params).id;
      return { asset: await asset(c, id), history: await history(c, id), disposals: await disposals(c, id) };
    }),
  );
  app.post(
    '/api/fixed-assets/:id/depreciation',
    tenantRoute(
      app,
      { ...write, limit: { name: 'asset-depreciation', max: 20, windowMs: 60000 } },
      async (c) => {
        const id = idParam.parse(c.req.params).id,
          { month, version } = z
            .object({ month: monthSchema, version: z.number().int().positive() })
            .parse(c.req.body);
        const row = await asset(c, id, true);
        if (!row.active) throw conflict('Demirbaş kartı pasif.');
        if (row.version !== version) throw conflict('Kart değişti; hesaplamayı yenileyin.');
        if (month > todayIso().slice(0, 7))
          throw badRequest('Gelecek ay için amortisman oluşturulamaz.');
        const existing = (
          await c.tx.execute(
            sql`select ${historyFields} from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.asset_id=${id}::uuid and d.month=${month} and d.cancelled_at is null`,
          )
        ).rows[0];
        if (existing) return { created: false, entry: existing };
        const calculated = depreciationForMonth(row.config, month);
        if (!calculated || dec(calculated.amount).lte(0))
          throw badRequest('Seçilen ay için amortisman tutarı yok.');
        await validate(c, row.config);
        const periodId = uuidv7(),
          [year, m] = month.split('-').map(Number),
          date = new Date(Date.UTC(year!, m!, 0)).toISOString().slice(0, 10);
        const journal = await createJournalEntry(
          c.tx,
          ledgerCtx(c),
          {
            entryDate: date,
            description: `Amortisman ${row.config.code} · ${row.config.name} · ${month}`.slice(
              0,
              300,
            ),
            post: false,
            lines: [
              {
                accountId: row.config.expenseAccountId,
                currency: c.company.baseCurrency as CurrencyCode,
                debit: calculated.amount,
                credit: '0',
                ...(row.config.projectId ? { projectId: row.config.projectId } : {}),
              },
              {
                accountId: row.config.accumulatedAccountId,
                currency: c.company.baseCurrency as CurrencyCode,
                debit: '0',
                credit: calculated.amount,
              },
            ],
          },
          { source: { type: 'asset_depreciation', id: periodId } },
        );
        await c.tx.execute(
          sql`insert into asset_depreciation(id,company_id,asset_id,month,amount,snapshot,journal_entry_id,created_by) values(${periodId},${c.company.id},${id},${month},${calculated.amount},${JSON.stringify(row.config)}::jsonb,${journal.id},${c.user.id})`,
        );
        void c.reply.code(201);
        return { created: true, entry: (await history(c, id)).find((r) => r.id === periodId) };
      },
    ),
  );
  app.post(
    '/api/fixed-assets/:id/depreciation/:periodId/cancel',
    tenantRoute(app, write, async (c) => {
      const { id, periodId } = z.object({ id: z.uuid(), periodId: z.uuid() }).parse(c.req.params),
        { reason, date } = z
          .object({ reason: z.string().trim().min(3).max(300), date: isoDate.optional() })
          .parse(c.req.body);
      await asset(c, id, true);
      const row = (
        await c.tx.execute<{
          journal_entry_id: string;
          cancelled_at: Date | null;
          status: string;
          entry_date: string;
        }>(
          sql`select d.journal_entry_id,d.cancelled_at,j.status,j.entry_date::text from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.id=${periodId}::uuid and d.asset_id=${id}::uuid for update of d,j`,
        )
      ).rows[0];
      if (!row) throw notFound('Amortisman dönemi');
      if (row.cancelled_at) throw conflict('Amortisman zaten iptal edilmiş.');
      let reversalId: string | null = null;
      if (row.status === 'posted') {
        const entryDate = date ?? todayIso();
        if (entryDate < row.entry_date)
          throw badRequest('İptal tarihi kayıt tarihinden önce olamaz.');
        const reversal = await reverseJournalEntry(c.tx, ledgerCtx(c), row.journal_entry_id, {
          entryDate,
          description: `Amortisman iptali · ${reason}`,
          source: { type: 'asset_depreciation', id: periodId },
        });
        reversalId = reversal.id;
      }
      await c.tx.execute(
        sql`update asset_depreciation set cancelled_at=now(),cancel_reason=${reason},reversal_entry_id=${reversalId}::uuid where id=${periodId}::uuid`,
      );
      return { asset: await asset(c, id), history: await history(c, id) };
    }),
  );
  // Elden çıkarma (öneri 60): kayıtlı amortismanla defter değeri bulunur, yevmiye kaydedilir ve kart kapanır
  app.post(
    '/api/fixed-assets/:id/dispose',
    tenantRoute(app, { ...write, limit: { name: 'asset-disposal', max: 20, windowMs: 60000 } }, async (c) => {
      const id = idParam.parse(c.req.params).id,
        input = assetDisposalSchema.parse(c.req.body);
      const row = await asset(c, id, true);
      if (row.disposedOn) throw conflict('Demirbaş zaten elden çıkarılmış.', 'ASSET_DISPOSED');
      if (row.version !== input.version) throw conflict('Kart değişti; yenileyin.');
      if (input.date < row.config.acquisitionDate) throw badRequest('Elden çıkarma tarihi edinim tarihinden önce olamaz.');
      if (input.date > todayIso()) throw badRequest('Gelecek tarihli elden çıkarma kaydedilemez.');
      if (dec(String(row.draftAmount)).gt(0))
        throw unprocessable('Taslak amortisman yevmiyeleri var; önce kaydedin ya da iptal edin.', 'ASSET_DRAFT_DEPRECIATION');
      const posted = new Set(
        (
          await c.tx.execute<{ month: string }>(
            sql`select d.month from asset_depreciation d join journal_entries j on j.id=d.journal_entry_id where d.asset_id=${id}::uuid and d.cancelled_at is null and j.status='posted' and j.reversed_by_id is null`,
          )
        ).rows.map((r) => r.month),
      );
      const missing = missingDepreciationMonths(row.config, input.date.slice(0, 7), posted);
      if (missing.length)
        throw unprocessable(`Elden çıkarma ayından önceki ${missing.length} ayın amortismanı kayıtlı değil (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`, 'ASSET_DEPRECIATION_MISSING', { missing });
      const cost = dec(row.config.cost).toFixed(2),
        accumulated = dec(String(row.postedAmount)).toFixed(2),
        proceeds = dec(input.proceeds).toFixed(2),
        { bookValue, gainLoss } = disposalResult(cost, accumulated, proceeds),
        gl = dec(gainLoss);
      if (gl.gt(0) && !input.gainAccountId) throw badRequest('Satış kârı için gelir hesabı seçin.', 'ASSET_DISPOSAL_ACCOUNT');
      if (gl.lt(0) && !input.lossAccountId) throw badRequest('Zarar için gider hesabı seçin.', 'ASSET_DISPOSAL_ACCOUNT');
      if (input.assetAccountId === row.config.accumulatedAccountId)
        throw badRequest('Demirbaş maliyet hesabı birikmiş amortisman hesabından farklı olmalı.', 'ASSET_DISPOSAL_ACCOUNT');
      await validateDisposalAccounts(c, [
        { id: input.assetAccountId, types: ['asset'], label: 'Demirbaş maliyet hesabı' },
        { id: dec(proceeds).gt(0) ? input.proceedsAccountId : null, types: ['asset'], label: 'Satış bedeli karşı hesabı' },
        { id: gl.gt(0) ? input.gainAccountId : null, types: ['income'], label: 'Kâr hesabı' },
        // Tekdüzende 6 sınıfı (ör. 689) gelir tablosu hesabıdır ve 'income' türündedir
        { id: gl.lt(0) ? input.lossAccountId : null, types: ['expense', 'cost', 'income'], label: 'Zarar hesabı' },
      ]);
      const base = c.company.baseCurrency as CurrencyCode,
        line = (accountId: string, debit: string, credit: string) => ({ accountId, currency: base, debit, credit });
      const lines = [
        ...(dec(accumulated).gt(0) ? [line(row.config.accumulatedAccountId, accumulated, '0')] : []),
        ...(dec(proceeds).gt(0) ? [line(input.proceedsAccountId!, proceeds, '0')] : []),
        ...(gl.lt(0) ? [line(input.lossAccountId!, gl.abs().toFixed(2), '0')] : []),
        line(input.assetAccountId, '0', cost),
        ...(gl.gt(0) ? [line(input.gainAccountId!, '0', gl.toFixed(2))] : []),
      ];
      const disposalId = uuidv7();
      const journal = await createJournalEntry(
        c.tx,
        ledgerCtx(c),
        {
          entryDate: input.date,
          description: `${input.method === 'sale' ? 'Demirbaş satışı' : 'Demirbaş hurdaya ayırma'} ${row.config.code} · ${row.config.name}`.slice(0, 300),
          post: true,
          lines,
        },
        { source: { type: 'asset_disposal', id: disposalId } },
      );
      const accounts = {
        assetAccountId: input.assetAccountId,
        proceedsAccountId: dec(proceeds).gt(0) ? input.proceedsAccountId : null,
        gainAccountId: gl.gt(0) ? input.gainAccountId : null,
        lossAccountId: gl.lt(0) ? input.lossAccountId : null,
      };
      await c.tx.execute(
        sql`insert into asset_disposals(id,company_id,asset_id,disposal_date,method,proceeds,cost,accumulated,book_value,gain_loss,accounts,note,journal_entry_id,created_by) values(${disposalId},${c.company.id},${id},${input.date},${input.method},${proceeds},${cost},${accumulated},${bookValue},${gainLoss},${JSON.stringify(accounts)}::jsonb,${input.note},${journal.id},${c.user.id})`,
      );
      await c.tx.execute(sql`update fixed_assets set active=false,version=version+1,updated_at=now() where id=${id}::uuid`);
      void c.reply.code(201);
      return { asset: await asset(c, id), disposals: await disposals(c, id) };
    }),
  );
  app.post(
    '/api/fixed-assets/:id/disposals/:disposalId/cancel',
    tenantRoute(app, write, async (c) => {
      const { id, disposalId } = z.object({ id: z.uuid(), disposalId: z.uuid() }).parse(c.req.params),
        { reason, date } = z.object({ reason: z.string().trim().min(3).max(300), date: isoDate.optional() }).parse(c.req.body);
      await asset(c, id, true);
      const row = (
        await c.tx.execute<{ journal_entry_id: string; cancelled_at: Date | null; disposal_date: string }>(
          sql`select journal_entry_id,cancelled_at,disposal_date::text from asset_disposals where id=${disposalId}::uuid and asset_id=${id}::uuid for update`,
        )
      ).rows[0];
      if (!row) throw notFound('Elden çıkarma');
      if (row.cancelled_at) throw conflict('Elden çıkarma zaten iptal edilmiş.');
      const entryDate = date ?? todayIso();
      if (entryDate < row.disposal_date) throw badRequest('İptal tarihi elden çıkarma tarihinden önce olamaz.');
      const reversal = await reverseJournalEntry(c.tx, ledgerCtx(c), row.journal_entry_id, {
        entryDate,
        description: `Elden çıkarma iptali · ${reason}`,
        source: { type: 'asset_disposal', id: disposalId },
      });
      await c.tx.execute(
        sql`update asset_disposals set cancelled_at=now(),cancel_reason=${reason},reversal_entry_id=${reversal.id}::uuid where id=${disposalId}::uuid`,
      );
      await c.tx.execute(sql`update fixed_assets set active=true,version=version+1,updated_at=now() where id=${id}::uuid`);
      return { asset: await asset(c, id), disposals: await disposals(c, id) };
    }),
  );
};
