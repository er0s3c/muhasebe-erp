import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { isValidIban, maskIban, normalizeIban } from '@erp/shared';
import { parties, partyBankAccounts, users } from '../../db/schema';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { decryptField, encryptField, hashId, lastFour } from '../hr/crypto';

const createSchema = z.object({
  iban: z.string().trim().transform(normalizeIban).refine(isValidIban, 'Geçersiz IBAN (denetim hanesi tutmuyor)'),
  holderName: z.string().trim().min(2).max(140),
  bankName: z.string().trim().max(120).optional().transform((v) => v || null),
  note: z.string().trim().max(500).optional().transform((v) => v || null),
});
const verifySchema = z.object({
  method: z.enum(['phone_callback', 'signed_document', 'bank_letter', 'other']),
  note: z.string().trim().min(3).max(500),
});
const noteSchema = z.object({ note: z.string().trim().min(3).max(500) });
const params = z.object({ id: z.string().uuid(), accountId: z.string().uuid().optional() });

/**
 * Cari banka hesapları ve değişiklik kontrolü (öneri 53). Ödeme sahtekârlığının en yaygın yolu tedarikçi IBAN'ının
 * değiştirilmesidir: yeni/değişen hesap doğrulama bekler; doğrulayan talep edenden farklı olmalı ve bağımsız teyit yöntemini
 * (bilinen numaradan geri arama, imzalı belge, banka yazısı) kaydetmelidir. Aynı IBAN başka bir caride de kayıtlıysa uyarılır.
 * Tam IBAN yalnız doğrulanmış hesapta ve kasa/banka görme yetkisiyle açılır.
 */
export const partyBankAccountRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.parties', permission: 'parties.read' } as const;
  const manage = { module: 'core.parties', permission: 'parties.manage' } as const;
  const finance = { module: 'core.treasury', permission: 'treasury.manage' } as const;
  const secret = app.config.JWT_SECRET;
  const requester = alias(users, 'requester');
  const decider = alias(users, 'decider');
  const hash = (iban: string) => hashId('party-iban', iban, secret);

  async function list(c: TenantCtx, partyId: string) {
    const rows = await c.tx
      .select({
        id: partyBankAccounts.id, ibanLast4: partyBankAccounts.ibanLast4, ibanHash: partyBankAccounts.ibanHash, ibanEnc: partyBankAccounts.ibanEnc,
        bankName: partyBankAccounts.bankName, holderName: partyBankAccounts.holderName, status: partyBankAccounts.status,
        requestedBy: partyBankAccounts.requestedBy, requestedByName: requester.fullName, requestedAt: partyBankAccounts.requestedAt, requestNote: partyBankAccounts.requestNote,
        decidedByName: decider.fullName, decidedAt: partyBankAccounts.decidedAt, verificationMethod: partyBankAccounts.verificationMethod,
        decisionNote: partyBankAccounts.decisionNote, revokedAt: partyBankAccounts.revokedAt,
      })
      .from(partyBankAccounts)
      .innerJoin(requester, eq(requester.id, partyBankAccounts.requestedBy))
      .leftJoin(decider, eq(decider.id, partyBankAccounts.decidedBy))
      .where(eq(partyBankAccounts.partyId, partyId))
      .orderBy(desc(partyBankAccounts.requestedAt));
    const live = rows.filter((r) => r.status === 'pending' || r.status === 'verified');
    const others = live.length
      ? await c.tx
          .select({ ibanHash: partyBankAccounts.ibanHash, partyId: parties.id, partyName: parties.name })
          .from(partyBankAccounts)
          .innerJoin(parties, eq(parties.id, partyBankAccounts.partyId))
          .where(and(inArray(partyBankAccounts.ibanHash, live.map((r) => r.ibanHash)), ne(partyBankAccounts.partyId, partyId), inArray(partyBankAccounts.status, ['pending', 'verified'])))
      : [];
    return rows.map(({ ibanHash, ibanEnc, ...r }) => ({
      ...r,
      // Ülke kodu şifreli değerden okunur; tam IBAN dönmez
      ibanMasked: maskIban(decryptField(ibanEnc, secret).slice(0, 2), r.ibanLast4),
      ownRequest: r.requestedBy === c.user.id,
      alsoUsedBy: r.status === 'pending' || r.status === 'verified' ? others.filter((o) => o.ibanHash === ibanHash).map((o) => ({ partyId: o.partyId, partyName: o.partyName })) : [],
    }));
  }
  async function account(c: TenantCtx, partyId: string, accountId: string) {
    const [row] = await c.tx.select().from(partyBankAccounts).where(and(eq(partyBankAccounts.id, accountId), eq(partyBankAccounts.partyId, partyId))).for('update');
    if (!row) throw notFound('Banka hesabı');
    return row;
  }

  app.get('/api/parties/:id/bank-accounts', tenantRoute(app, read, async (c) => {
    const { id } = params.parse(c.req.params);
    return { accounts: await list(c, id) };
  }));

  app.post('/api/parties/:id/bank-accounts', tenantRoute(app, { ...manage, operation: 'update' }, async (c) => {
    const { id } = params.parse(c.req.params);
    const input = createSchema.parse(c.req.body);
    const [party] = await c.tx.select({ id: parties.id }).from(parties).where(eq(parties.id, id));
    if (!party) throw notFound('Cari');
    const ibanHash = hash(input.iban);
    const [existing] = await c.tx.select({ id: partyBankAccounts.id }).from(partyBankAccounts)
      .where(and(eq(partyBankAccounts.partyId, id), eq(partyBankAccounts.ibanHash, ibanHash), inArray(partyBankAccounts.status, ['pending', 'verified'])));
    if (existing) throw unprocessable('Bu IBAN bu caride zaten kayıtlı', 'BANK_ACCOUNT_EXISTS');
    await c.tx.insert(partyBankAccounts).values({
      id: randomUUID(), companyId: c.company.id, partyId: id, ibanEnc: encryptField(input.iban, secret), ibanLast4: lastFour(input.iban), ibanHash,
      bankName: input.bankName, holderName: input.holderName, requestedBy: c.user.id, requestNote: input.note,
    });
    void c.reply.code(201);
    return { accounts: await list(c, id) };
  }));

  const decide = (outcome: 'verified' | 'rejected') => tenantRoute(app, { ...finance, operation: 'update' }, async (c) => {
    const { id, accountId } = params.parse(c.req.params);
    const input = outcome === 'verified' ? verifySchema.parse(c.req.body) : { method: null, ...noteSchema.parse(c.req.body) };
    const row = await account(c, id, accountId!);
    if (row.status !== 'pending') throw unprocessable('Yalnız doğrulama bekleyen hesap karara bağlanır', 'BANK_ACCOUNT_NOT_PENDING');
    // Dört göz: hesabı giren kişi kendi talebini doğrulayamaz ya da reddedemez
    if (row.requestedBy === c.user.id) throw unprocessable('Banka hesabını giren kişi doğrulayamaz; başka bir yetkili teyit etmeli', 'BANK_ACCOUNT_FOUR_EYES');
    await c.tx.update(partyBankAccounts).set({ status: outcome, decidedBy: c.user.id, decidedAt: sql`now()`, verificationMethod: input.method, decisionNote: input.note })
      .where(eq(partyBankAccounts.id, accountId!));
    return { accounts: await list(c, id) };
  });
  app.post('/api/parties/:id/bank-accounts/:accountId/verify', decide('verified'));
  app.post('/api/parties/:id/bank-accounts/:accountId/reject', decide('rejected'));

  app.post('/api/parties/:id/bank-accounts/:accountId/revoke', tenantRoute(app, { ...manage, operation: 'update' }, async (c) => {
    const { id, accountId } = params.parse(c.req.params);
    const row = await account(c, id, accountId!);
    if (row.status !== 'verified') throw unprocessable('Yalnız doğrulanmış hesap kaldırılır', 'BANK_ACCOUNT_NOT_VERIFIED');
    await c.tx.update(partyBankAccounts).set({ status: 'revoked', revokedBy: c.user.id, revokedAt: sql`now()` }).where(eq(partyBankAccounts.id, accountId!));
    return { accounts: await list(c, id) };
  }));

  // Tam IBAN: yalnız doğrulanmış hesap ve kasa/banka görme yetkisi (ödeme hazırlayan)
  app.get('/api/parties/:id/bank-accounts/:accountId/iban', tenantRoute(app, { module: 'core.treasury', permission: 'treasury.read' }, async (c) => {
    const { id, accountId } = params.parse(c.req.params);
    const [row] = await c.tx.select().from(partyBankAccounts).where(and(eq(partyBankAccounts.id, accountId!), eq(partyBankAccounts.partyId, id)));
    if (!row) throw notFound('Banka hesabı');
    if (row.status !== 'verified') throw forbidden('Doğrulanmamış banka hesabı ödeme için açılmaz', 'BANK_ACCOUNT_NOT_VERIFIED');
    return { iban: decryptField(row.ibanEnc, secret) };
  }));
};
