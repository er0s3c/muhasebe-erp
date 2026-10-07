import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { dec, toDbAmount, type CurrencyCode, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { notFound, unprocessable } from '../../http/errors';
import type { StockCtx } from '../inventory/documents';
import { requireItemMappings } from '../inventory/accounting';
import { requireMappings } from '../ledger/mappings';
import { createJournalEntry, type AutoJournalLine } from '../ledger/journal';
export type LeatherCtx = StockCtx;
export const newId = randomUUID;
// Raw tenant-scoped SQL projections contain heterogeneous JSON config payloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
export async function one(tx: Tx, query: SQL, label = 'Kayıt'): Promise<Row> { const r = await tx.execute(query); if (!r.rows[0]) throw notFound(label); return r.rows[0] as Row; }
export async function all(tx: Tx, query: SQL): Promise<Row[]> { return (await tx.execute(query)).rows as Row[]; }
export const fail = (message: string, code = 'LEATHER_INVALID') => unprocessable(message, code);
export async function lockLeatherCosts(tx: Tx, companyId: string): Promise<void> { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'leather-costs:' + companyId},0))`); }
export async function mapped(tx: Tx, key: string): Promise<string> { const m = await requireMappings(tx, [key as never]); return (m as Record<string,string>)[key]!; }
export async function itemAccounts(tx: Tx, itemId: string) { return (await requireItemMappings(tx, [itemId])).get(itemId)!; }
export function journalLine(ctx: LeatherCtx, accountId: string, signedDebit: MoneyValue | string, description?: string): AutoJournalLine { const a = dec(signedDebit); return { accountId, currency: ctx.baseCurrency as CurrencyCode, debit: a.gt(0) ? toDbAmount(a) : '0', credit: a.lt(0) ? toDbAmount(a.abs()) : '0', ...(description ? { description } : {}) }; }
export async function journal(tx: Tx, ctx: LeatherCtx, date: string, sourceType: string, sourceId: string, description: string, lines: AutoJournalLine[]): Promise<string | null> { const nonzero = lines.filter(l => dec(l.debit).gt(0) || dec(l.credit).gt(0)); if (!nonzero.length) return null; return (await createJournalEntry(tx, ctx, { entryDate: date, description, lines: nonzero, post: true }, { source: { type: sourceType, id: sourceId } })).id; }
export async function requireGoods(tx: Tx, itemId: string, role?: string): Promise<Row> { const i = await one(tx, sql`select * from items where id=${itemId}::uuid`, 'Stok kartı'); if (i.kind !== 'goods' || !i.is_active) throw fail('Aktif mal kartı gerekli', 'LEATHER_ITEM_INVALID'); if (role && i.inventory_role !== role) throw fail(`Stok kartı rolü ${role} olmalı`, 'LEATHER_ITEM_ROLE'); return i; }
export async function requireParty(tx: Tx, id: string): Promise<Row> { const p = await one(tx, sql`select * from parties where id=${id}::uuid`, 'Cari'); if (!p.is_active) throw fail('Cari pasif'); return p; }
