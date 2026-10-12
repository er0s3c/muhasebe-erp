import { describe, expect, it } from 'vitest';
import { createTreasuryTransactionSchema, effectivePermissions } from '@erp/shared';
import { withContext } from '../src/db/client';
import { decide } from '../src/modules/approvals/service';
import { postTreasuryTransaction } from '../src/modules/treasury/posting';
import {
  accountIds,
  addMember,
  asDb,
  client,
  createCompany,
  day,
  expectDbError,
  makeApp,
  orgOf,
  registerUser,
} from './helpers';

describe('mali belge onayları: gerçek kayıt, içerik sürümü ve güncel erişim', async () => {
  const { app, handle } = await makeApp();
  const ok = async (p: ReturnType<ReturnType<typeof client>['get']>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const error = async (
    p: ReturnType<ReturnType<typeof client>['get']>,
    status: number,
    code: string,
  ) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    expect(r.json().error.code).toBe(code);
  };
  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const accountant = await addMember(app, owner, company.id, 'accountant');
    const ids = await accountIds(app, s.token, company.id);
    const party = (await ok(owner.post('/api/parties', { name: 'Onay müşterisi' }), 201)).party;
    return { s, company, owner, accountant, ids, party, orgId: await orgOf(app, s.token) };
  }
  const invoiceBody = (
    w: Awaited<ReturnType<typeof world>>,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'sales',
    partyId: w.party.id,
    invoiceDate: day(3, 10),
    lines: [
      {
        description: 'Hizmet',
        accountId: w.ids['600'],
        quantity: '1',
        unitPrice: '100',
        vatCode: null,
      },
    ],
    ...extra,
  });
  const rule = (
    w: Awaited<ReturnType<typeof world>>,
    docType: string,
    extra: Record<string, unknown> = {},
  ) =>
    ok(
      w.owner.post('/api/document-approvals/rules', {
        docType,
        minAmount: '0',
        separateRequester: true,
        steps: [{ role: 'accountant' }],
        ...extra,
      }),
      201,
    );
  const submit = (w: Awaited<ReturnType<typeof world>>, type: string, id: string) =>
    ok(w.owner.post(`/api/document-approvals/documents/${type}/${id}/submit`, {}), 201);

  it('fatura: tek aktif talep, onaydayken edit/delete/post engeli, son karar atomik kayıt', async () => {
    const w = await world('DocInvoice');
    await rule(w, 'invoice', {
      steps: [
        { role: 'accountant', label: 'İlk kontrol' },
        { role: 'accountant', label: 'Mali kontrol' },
      ],
    });
    await error(
      w.owner.post('/api/invoices', invoiceBody(w, { post: true })),
      422,
      'APPROVAL_REQUIRED',
    );
    const inv = (await ok(w.owner.post('/api/invoices', invoiceBody(w)), 201)).invoice;
    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        w.owner.post(`/api/document-approvals/documents/invoice/${inv.id}/submit`, {}),
      ),
    );
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(2);
    const request = attempts.find((r) => r.statusCode === 201)!.json().request;
    await error(w.owner.put(`/api/invoices/${inv.id}`, invoiceBody(w)), 409, 'APPROVAL_PENDING');
    await error(w.owner.delete(`/api/invoices/${inv.id}`), 409, 'APPROVAL_PENDING');
    await error(w.owner.post(`/api/invoices/${inv.id}/post`, {}), 409, 'APPROVAL_PENDING');
    expect(
      (
        await ok(
          w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
            decision: 'approve',
          }),
        )
      ).request.status,
    ).toBe('pending');
    expect((await ok(w.owner.get(`/api/invoices/${inv.id}`))).invoice.journalEntryId).toBeNull();
    expect(
      (
        await ok(
          w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
            decision: 'approve',
          }),
        )
      ).request.status,
    ).toBe('approved');
    const posted = (await ok(w.owner.get(`/api/invoices/${inv.id}`))).invoice;
    expect(posted.status).toBe('posted');
    expect(posted.journalEntryId).toBeTruthy();
    await error(
      w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
        decision: 'approve',
      }),
      422,
      'APPROVAL_NOT_PENDING',
    );
  });
  it('manuel onay: kendi kararını engeller; kur değişince onay geri alınmadan kayıt yapılmaz, ret ve tekrar sunma çalışır', async () => {
    const w = await world('DocRevision');
    await ok(
      w.owner.put('/api/exchange-rates', {
        rateDate: day(3, 10),
        currencyCode: 'USD',
        quoteCode: 'TRY',
        buy: '30',
      }),
    );
    const body = invoiceBody(w, { currency: 'USD' });
    const inv = (await ok(w.owner.post('/api/invoices', body), 201)).invoice;
    const req = (await submit(w, 'invoice', inv.id)).request;
    await error(
      w.owner.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
      422,
      'APPROVAL_SELF_DECISION',
    );
    await ok(
      w.owner.put('/api/exchange-rates', {
        rateDate: day(3, 10),
        currencyCode: 'USD',
        quoteCode: 'TRY',
        buy: '35',
      }),
    );
    await error(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
      422,
      'APPROVAL_DOCUMENT_CHANGED',
    );
    expect((await ok(w.owner.get(`/api/invoices/${inv.id}`))).invoice.status).toBe('draft');
    await ok(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, {
        decision: 'reject',
        note: 'Kur değişti',
      }),
    );
    await ok(w.owner.put(`/api/invoices/${inv.id}`, body));
    const next = (await submit(w, 'invoice', inv.id)).request;
    expect(next.id).not.toBe(req.id);
    await ok(
      w.accountant.client.post(`/api/document-approvals/${next.id}/decide`, {
        decision: 'approve',
      }),
    );
    expect((await ok(w.owner.get(`/api/invoices/${inv.id}`))).invoice.status).toBe('posted');
  });
  it('onaylayıcının güncel izin ve güncelleme hakkı kararı kapatır; eski URL mali belgeyi sızdırmaz', async () => {
    const w = await world('DocPermission');
    await rule(w, 'invoice');
    const inv = (await ok(w.owner.post('/api/invoices', invoiceBody(w)), 201)).invoice;
    const req = (await submit(w, 'invoice', inv.id)).request;
    const path = `/api/company/members/${w.accountant.userId}/module-access`;
    await ok(w.owner.put(path, { permissions: { 'invoices.post': 'deny' } }));
    expect(
      (
        await w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(403);
    await ok(
      w.owner.put(path, {
        permissions: { 'invoices.post': 'default' },
        operations: { 'operation.core.invoices.update': 'deny' },
      }),
    );
    await error(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
      403,
      'RESOURCE_OPERATION_DENIED',
    );
    expect((await w.accountant.client.get(`/api/approvals/${req.id}`)).statusCode).toBe(404);
    await ok(w.owner.put(path, { operations: { 'operation.core.invoices.update': 'default' } }));
    await ok(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
    );
  });
  it('teklif: onay müşteri gönderimine geçer; tekrar açılıp düzenlenen sürüm eski onayı kullanamaz', async () => {
    const w = await world('DocQuote');
    await rule(w, 'sales_quote');
    const body = {
      kind: 'quote',
      partyId: w.party.id,
      docDate: day(3, 10),
      lines: [{ description: 'Teklif hizmeti', quantity: '1', unitPrice: '100', vatCode: null }],
    };
    const doc = (await ok(w.owner.post('/api/sales-docs', body), 201)).doc;
    await error(w.owner.post(`/api/sales-docs/${doc.id}/send`, {}), 422, 'APPROVAL_REQUIRED');
    const req = (await submit(w, 'sales_quote', doc.id)).request;
    await ok(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
    );
    expect((await ok(w.owner.get(`/api/sales-docs/${doc.id}`))).doc.status).toBe('sent');
    await ok(w.owner.post(`/api/sales-docs/${doc.id}/reopen`, {}));
    await ok(
      w.owner.put(`/api/sales-docs/${doc.id}`, {
        ...body,
        lines: [{ description: 'Revize teklif', quantity: '1', unitPrice: '200', vatCode: null }],
      }),
    );
    await error(w.owner.post(`/api/sales-docs/${doc.id}/send`, {}), 422, 'APPROVAL_REQUIRED');
  });
  it('ödeme ve gider: önce gerçek taslak, onay sonrası tek mali kayıt; ret/geri çekme düzenlemeyi açar', async () => {
    const w = await world('DocFinancial');
    const bank = (
      await ok(
        w.owner.post('/api/treasury/accounts', {
          kind: 'bank',
          name: 'Onay bankası',
          currency: 'TRY',
        }),
        201,
      )
    ).account;
    await rule(w, 'payment');
    await rule(w, 'expense');
    const payload = {
      type: 'other_payment',
      date: day(3, 10),
      accountId: bank.id,
      glAccountId: w.ids['632'],
      amount: '75',
      description: 'Kontrollü ödeme',
    };
    await error(w.owner.post('/api/treasury/transactions', payload), 422, 'APPROVAL_REQUIRED');
    const draft = (
      await ok(w.owner.post('/api/financial-approval-drafts', { docType: 'payment', payload }), 201)
    ).draft;
    const req = (await ok(w.owner.post(`/api/financial-approval-drafts/${draft.id}/submit`, {})))
      .request;
    await error(
      w.owner.put(`/api/financial-approval-drafts/${draft.id}`, { docType: 'payment', payload }),
      422,
      'APPROVAL_PENDING',
    );
    await ok(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
    );
    const posted = (await ok(w.owner.get(`/api/financial-approval-drafts/${draft.id}`))).draft;
    expect(posted.status).toBe('posted');
    expect(posted.postedDocId).toBeTruthy();
    expect(
      (await ok(w.owner.get(`/api/treasury/transactions/${posted.postedDocId}`))).transaction
        .amount,
    ).toBe('75.0000');
    const card = (
      await ok(
        w.owner.post('/api/expense-cards', {
          code: 'APP',
          name: 'Onay gideri',
          accountId: w.ids['632'],
        }),
        201,
      )
    ).card;
    const expense = {
      entryDate: day(3, 10),
      cardId: card.id,
      description: 'Kontrollü gider',
      net: '60',
      paymentKind: 'treasury',
      treasuryAccountId: bank.id,
    };
    await error(w.owner.post('/api/expense-entries', expense), 422, 'APPROVAL_REQUIRED');
    const expenseDraft = (
      await ok(
        w.owner.post('/api/financial-approval-drafts', { docType: 'expense', payload: expense }),
        201,
      )
    ).draft;
    const rejected = (
      await ok(w.owner.post(`/api/financial-approval-drafts/${expenseDraft.id}/submit`, {}))
    ).request;
    await ok(
      w.accountant.client.post(`/api/document-approvals/${rejected.id}/decide`, {
        decision: 'reject',
        note: 'Belgeyi düzeltin',
      }),
    );
    await ok(
      w.owner.put(`/api/financial-approval-drafts/${expenseDraft.id}`, {
        docType: 'expense',
        payload: { ...expense, net: '65' },
      }),
    );
    const cancelled = (
      await ok(w.owner.post(`/api/financial-approval-drafts/${expenseDraft.id}/submit`, {}))
    ).request;
    await ok(w.owner.post(`/api/document-approvals/${cancelled.id}/cancel`, {}));
    await ok(
      w.owner.put(`/api/financial-approval-drafts/${expenseDraft.id}`, {
        docType: 'expense',
        payload: { ...expense, net: '65' },
      }),
    );
    const final = (
      await ok(w.owner.post(`/api/financial-approval-drafts/${expenseDraft.id}/submit`, {}))
    ).request;
    await ok(
      w.accountant.client.post(`/api/document-approvals/${final.id}/decide`, {
        decision: 'approve',
      }),
    );
    const expensePosted = (
      await ok(w.owner.get(`/api/financial-approval-drafts/${expenseDraft.id}`))
    ).draft;
    expect(expensePosted.status).toBe('posted');
    expect(
      (await ok(w.owner.get(`/api/expense-entries/${expensePosted.postedDocId}`))).entry.net,
    ).toBe('65.0000');
    await asDb(
      handle,
      { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id },
      async (q) => {
        expect(
          (
            await expectDbError(
              q,
              'update financial_approval_drafts set payload=$2::jsonb where id=$1',
              [draft.id, JSON.stringify(payload)],
            )
          ).code,
        ).toBe('ERP10');
      },
    );
  });
  it('şube kapsamı ve şirket izolasyonu onay görünümünde ve nihai yevmiyede korunur', async () => {
    const w = await world('DocBranch');
    const a = (
      await ok(w.owner.post('/api/company/branches', { code: 'A', name: 'A şubesi' }), 201)
    ).branch;
    const b = (
      await ok(w.owner.post('/api/company/branches', { code: 'B', name: 'B şubesi' }), 201)
    ).branch;
    const bank = (
      await ok(
        w.owner.post('/api/treasury/accounts', {
          kind: 'bank',
          name: 'Şube bankası',
          currency: 'TRY',
        }),
        201,
      )
    ).account;
    const ownerInA = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${w.s.token}`,
          'x-company-id': w.company.id,
          'x-branch-id': a.id,
        },
        payload: payload as object,
      });
    const draft = (
      await ok(
        ownerInA('/api/financial-approval-drafts', {
          docType: 'payment',
          payload: {
            type: 'other_payment',
            date: day(3, 10),
            accountId: bank.id,
            glAccountId: w.ids['632'],
            amount: '10',
          },
        }),
        201,
      )
    ).draft;
    const req = (await ok(ownerInA(`/api/financial-approval-drafts/${draft.id}/submit`, {})))
      .request;
    await ok(
      w.owner.put(`/api/company/members/${w.accountant.userId}/branches`, {
        mode: 'restricted',
        allowUnassigned: false,
        branchIds: [b.id],
      }),
    );
    expect((await w.accountant.client.get(`/api/document-approvals/${req.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(404);
    await ok(
      w.owner.put(`/api/company/members/${w.accountant.userId}/branches`, {
        mode: 'restricted',
        allowUnassigned: false,
        branchIds: [a.id],
      }),
    );
    await ok(
      w.accountant.client.post(`/api/document-approvals/${req.id}/decide`, { decision: 'approve' }),
    );
    const posted = (await ok(w.owner.get(`/api/financial-approval-drafts/${draft.id}`))).draft;
    const txn = (await ok(w.owner.get(`/api/treasury/transactions/${posted.postedDocId}`)))
      .transaction;
    expect(
      (await ok(w.owner.get(`/api/journal-entries/${txn.journalEntryId}`))).entry.branchId,
    ).toBe(a.id);
    const foreign = await registerUser(app, 'DocForeign');
    const foreignCompany = await createCompany(app, foreign.token);
    expect(
      (await client(app, foreign.token, foreignCompany.id).get(`/api/document-approvals/${req.id}`))
        .statusCode,
    ).toBe(404);
  });
  it('tamamlanan ödeme kanıtı aynı hizmet üzerinden ikinci mali kayıt üretmek için kullanılamaz; tutar sessizce yuvarlanmaz', async () => {
    const w = await world('DocProofReuse');
    const bank = (
      await ok(
        w.owner.post('/api/treasury/accounts', {
          kind: 'bank',
          name: 'Tek kullanımlı onay',
          currency: 'TRY',
        }),
        201,
      )
    ).account;
    const payload = {
      type: 'other_payment',
      date: day(3, 10),
      accountId: bank.id,
      glAccountId: w.ids['632'],
      amount: '20',
    };
    await error(
      w.owner.post('/api/financial-approval-drafts', {
        docType: 'payment',
        payload: { ...payload, amount: '20.1234' },
      }),
      422,
      'AMOUNT_PRECISION',
    );
    const draft = (
      await ok(w.owner.post('/api/financial-approval-drafts', { docType: 'payment', payload }), 201)
    ).draft;
    const request = (
      await ok(w.owner.post(`/api/financial-approval-drafts/${draft.id}/submit`, {}))
    ).request;
    await ok(
      w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
        decision: 'approve',
      }),
    );
    await expect(
      withContext(
        handle.db,
        { userId: w.accountant.userId, orgId: w.orgId, companyId: w.company.id },
        (tx) =>
          postTreasuryTransaction(
            tx,
            {
              companyId: w.company.id,
              userId: w.accountant.userId,
              baseCurrency: 'TRY',
              reportingCurrency: null,
              approvalRequestId: request.id,
            },
            createTreasuryTransactionSchema.parse(payload),
          ),
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_DOCUMENT_CHANGED' });
    expect((await ok(w.owner.get('/api/treasury/transactions'))).transactions).toHaveLength(1);
  });
  it('karar rolü güncel üyelikten gelir; eski rol bağlamı ve mali okuma izni olmayan erişim talebi açamaz', async () => {
    const w = await world('DocLiveRole');
    await rule(w, 'invoice');
    const inv = (await ok(w.owner.post('/api/invoices', invoiceBody(w)), 201)).invoice;
    const request = (await submit(w, 'invoice', inv.id)).request;
    await ok(w.owner.patch(`/api/company/members/${w.accountant.userId}`, { role: 'admin' }));
    await expect(
      withContext(
        handle.db,
        { userId: w.accountant.userId, orgId: w.orgId, companyId: w.company.id },
        (tx) =>
          decide(
            tx,
            {
              companyId: w.company.id,
              userId: w.accountant.userId,
              role: 'accountant',
              permissions: effectivePermissions('accountant'),
            },
            request.id,
            { decision: 'approve' },
          ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await ok(w.owner.patch(`/api/company/members/${w.accountant.userId}`, { role: 'accountant' }));
    await ok(
      w.owner.put(`/api/company/members/${w.accountant.userId}/module-access`, {
        permissions: { 'invoices.read': 'deny' },
      }),
    );
    expect(
      (await w.accountant.client.get(`/api/document-approvals/${request.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await ok(w.accountant.client.get('/api/document-approvals/inbox'))).requests,
    ).toHaveLength(0);
    expect((await w.accountant.client.get(`/api/approvals/${request.id}`)).statusCode).toBe(404);
  });
  it('proje özel ödeme/fatura kuralı uygulanır; çok projeli mali belge kural kapsamını atlayamaz', async () => {
    const w = await world('DocProjectRule');
    const project = (
      await ok(w.owner.post('/api/projects', { name: 'Onay projesi', kind: 'own' }), 201)
    ).project;
    const other = (
      await ok(w.owner.post('/api/projects', { name: 'Diğer onay projesi', kind: 'own' }), 201)
    ).project;
    const bank = (
      await ok(
        w.owner.post('/api/treasury/accounts', {
          kind: 'bank',
          name: 'Proje onay bankası',
          currency: 'TRY',
        }),
        201,
      )
    ).account;
    await rule(w, 'payment', { projectId: project.id });
    const payout = {
      type: 'other_payment',
      date: day(3, 10),
      accountId: bank.id,
      glAccountId: w.ids['632'],
      amount: '30',
      projectId: project.id,
    };
    await error(w.owner.post('/api/treasury/transactions', payout), 422, 'APPROVAL_REQUIRED');
    await ok(w.owner.post('/api/treasury/transactions', { ...payout, projectId: other.id }), 201);
    await rule(w, 'invoice', { projectId: project.id });
    const supplier = (
      await ok(w.owner.post('/api/parties', { name: 'Onay tedarikçisi', kind: 'supplier' }), 201)
    ).party;
    const body = {
      type: 'expense',
      partyId: supplier.id,
      externalNo: 'APPROVAL-1',
      invoiceDate: day(3, 10),
      lines: [
        {
          description: 'Proje gideri',
          quantity: '1',
          unitPrice: '30',
          accountId: w.ids['632'],
          projectId: project.id,
          vatCode: null,
        },
      ],
    };
    const inv = (await ok(w.owner.post('/api/invoices', body), 201)).invoice;
    await error(w.owner.post(`/api/invoices/${inv.id}/post`, {}), 422, 'APPROVAL_REQUIRED');
    const request = (await submit(w, 'invoice', inv.id)).request;
    expect(request.projectId).toBe(project.id);
    await ok(
      w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
        decision: 'approve',
      }),
    );
    const multi = (
      await ok(
        w.owner.post('/api/invoices', {
          ...body,
          externalNo: 'APPROVAL-2',
          lines: [...body.lines, { ...body.lines[0], projectId: other.id }],
        }),
        201,
      )
    ).invoice;
    await error(
      w.owner.post(`/api/invoices/${multi.id}/post`, {}),
      422,
      'APPROVAL_MULTIPLE_PROJECTS',
    );
    await error(
      w.owner.post(`/api/document-approvals/documents/invoice/${multi.id}/submit`, {}),
      422,
      'APPROVAL_MULTIPLE_PROJECTS',
    );
  });
  it('eski kural uçları mali kural yönetimini atlayamaz; karşı taraf kimliği değişmiş talep yeniden sunulmalıdır', async () => {
    const w = await world('DocIdentity');
    const created = await rule(w, 'invoice');
    const inv = (await ok(w.owner.post('/api/invoices', invoiceBody(w)), 201)).invoice;
    const request = (await submit(w, 'invoice', inv.id)).request;
    await error(
      w.owner.post('/api/approval-rules', { docType: 'invoice', steps: [{ role: 'accountant' }] }),
      422,
      'APPROVAL_DOC_TYPE',
    );
    expect(
      (await w.owner.patch(`/api/approval-rules/${created.rule.id}`, { isActive: false }))
        .statusCode,
    ).toBe(404);
    await ok(
      w.owner.patch(`/api/parties/${w.party.id}`, {
        name: 'Kimliği güncellenen müşteri',
        taxNumber: '1234567890',
      }),
    );
    await error(
      w.accountant.client.post(`/api/document-approvals/${request.id}/decide`, {
        decision: 'approve',
      }),
      422,
      'APPROVAL_DOCUMENT_CHANGED',
    );
    await ok(w.owner.post(`/api/document-approvals/${request.id}/cancel`, {}));
    const next = (await submit(w, 'invoice', inv.id)).request;
    await ok(
      w.accountant.client.post(`/api/document-approvals/${next.id}/decide`, {
        decision: 'approve',
      }),
    );
    expect(
      (await ok(w.owner.get(`/api/invoices/${inv.id}`))).invoice.documentMetadata.party.name,
    ).toBe('Kimliği güncellenen müşteri');
  });
});
