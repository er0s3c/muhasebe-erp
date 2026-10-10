import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asDb, client, createCompany, makeApp, registerUser, type TestApp } from './helpers';

let fixture: TestApp;
let app: FastifyInstance;
beforeAll(async () => {
  fixture = await makeApp();
  app = fixture.app;
});
const source = 'https://www.gib.gov.tr/';
async function setup() {
  const user = await registerUser(app, 'DocumentTax');
  const company = await createCompany(app, user.token, { jurisdiction: 'TR', sector: 'COMMERCE' });
  const c = client(app, user.token, company.id);
  const party = (
    await c.post('/api/parties', {
      name: 'Vergi mükellefi müşteri',
      kind: 'both',
      taxStatus: 'withholding_agent',
    })
  ).json().party;
  return { user, company, c, party };
}
function ruleInput(overrides: Record<string, unknown> = {}) {
  return {
    code: 'TEST-SERVICE',
    name: 'Sentetik mali test kuralı',
    jurisdiction: 'TR',
    version: 'test-tax-v1',
    validFrom: '2026-01-01',
    validTo: null,
    productClass: 'test-service',
    transactionType: 'domestic',
    partyTaxStatus: 'withholding_agent',
    invoiceType: 'sales',
    sourceRefs: [source],
    sourceNote: 'Yalnız aritmetik regresyon testi; gerçek işlem için mevzuat kuralı değildir.',
    config: {
      taxTreatment: 'standard',
      vatCode: 'KDV-20',
      exemptionCode: null,
      vatWithholding: { numerator: 7, denominator: 10 },
      incomeWithholding: { ratePct: '10', basis: 'net' },
      stamp: { kind: 'fixed', amount: '9.48' },
      stampLiability: 'company',
    },
    ...overrides,
  };
}
function invoiceInput(partyId: string, taxRuleId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'sales',
    partyId,
    invoiceDate: '2026-10-01',
    post: true,
    lines: [
      {
        description: 'Test hizmeti',
        quantity: '3',
        unitPrice: '1000',
        vatCode: 'KDV-20',
        taxRuleId,
        productClass: 'test-service',
        transactionType: 'domestic',
      },
    ],
    ...overrides,
  };
}
async function verifiedRule(c: ReturnType<typeof client>, input = ruleInput()) {
  const created = await c.post('/api/document-tax-rules', input);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().rule.id as string;
  const reviewed = await c.post(`/api/document-tax-rules/${id}/verify`, { reviewed: true });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  expect((await c.patch(`/api/document-tax-rules/${id}`, { enabled: true })).statusCode).toBe(200);
  return id;
}

describe('Tarihli işlem vergisi ve gerçek muhasebe', () => {
  it('inceleme bekleyen kuralı muhasebeleştirmez; sınıf ve taraf durumu denetlenir', async () => {
    const { c, party } = await setup();
    const id = (await c.post('/api/document-tax-rules', ruleInput())).json().rule.id;
    const rejected = await c.post('/api/invoices', invoiceInput(party.id, id));
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe('TAX_RULE_NOT_VERIFIED');
    await c.post(`/api/document-tax-rules/${id}/verify`, { reviewed: true });
    await c.patch(`/api/document-tax-rules/${id}`, { enabled: true });
    const invalidClass = await c.post(
      '/api/invoices',
      invoiceInput(party.id, id, {
        lines: [
          {
            description: 'Başka hizmet',
            quantity: '1',
            unitPrice: '1000',
            taxRuleId: id,
            productClass: 'other-service',
            transactionType: 'domestic',
          },
        ],
      }),
    );
    expect(invalidClass.json().error.code).toBe('TAX_RULE_CLASSIFICATION');
    await c.patch(`/api/parties/${party.id}`, { taxStatus: 'consumer' });
    const invalidParty = await c.post('/api/invoices', invoiceInput(party.id, id));
    expect(invalidParty.json().error.code).toBe('TAX_RULE_CLASSIFICATION');
  });
  it('tevkifat, stopaj ve damgayı dengeli yevmiye ve cari bakiyeye yazar', async () => {
    const { c, party } = await setup();
    const id = await verifiedRule(c);
    const result = await c.post('/api/invoices', invoiceInput(party.id, id));
    expect(result.statusCode, result.body).toBe(201);
    const invoice = result.json().invoice;
    expect(invoice).toMatchObject({
      netTotal: '3000.0000',
      vatTotal: '600.0000',
      grossTotal: '3600.0000',
      taxTotalsSnapshot: {
        vatWithheld: '420.00',
        incomeWithheld: '300.00',
        stamp: '9.48',
        payableToSeller: '2880.00',
      },
    });
    const ledger = (await c.get(`/api/journal-entries/${invoice.journalEntryId}`)).json().entry;
    expect(ledger).toBeDefined();
    const detail = (await c.get(`/api/parties/${party.id}`)).json();
    expect(detail.summary.balance).toBe('2880.0000');
    expect(result.json().lines[0].taxRuleSnapshot).toMatchObject({
      version: 'test-tax-v1',
      sourceRefs: [source],
    });
  });
  it('iade, pasifleştirilmiş özgün kuralı ve geçmiş oranı kullanır; sabit damga bölüştürülür', async () => {
    const { c, party } = await setup();
    const id = await verifiedRule(c);
    const original = (await c.post('/api/invoices', invoiceInput(party.id, id))).json();
    await c.patch(`/api/document-tax-rules/${id}`, { enabled: false });
    const totals: number[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await c.post('/api/invoices', {
        type: 'sales_return',
        partyId: party.id,
        invoiceDate: '2026-10-02',
        returnOfId: original.invoice.id,
        post: true,
        lines: [
          {
            description: 'Kısmi iade',
            quantity: '1',
            unitPrice: '1000',
            sourceLineId: original.lines[0].id,
          },
        ],
      });
      expect(result.statusCode, result.body).toBe(201);
      expect(result.json().invoice.taxTotalsSnapshot).toMatchObject({
        vatWithheld: '140.00',
        incomeWithheld: '100.00',
        stamp: '3.16',
        payableToSeller: '960.00',
      });
      totals.push(Number(result.json().invoice.taxTotalsSnapshot.stamp));
      expect(result.json().lines[0].taxRuleSnapshot.version).toBe('test-tax-v1');
    }
    expect(totals.reduce((total, value) => total + value, 0)).toBeCloseTo(9.48);
    expect((await c.get(`/api/parties/${party.id}`)).json().summary.balance).toBe('0.0000');
  });
  it('sıfır oran ve istisnayı ayrı saklar; karma KDV tutarını korur', async () => {
    const { c, party } = await setup();
    expect(
      (
        await c.post('/api/tax-rates', {
          code: 'KDV-0',
          name: 'Test sıfır oran',
          rate: '0',
          validFrom: '2026-01-01',
          sourceNote: 'Sentetik test oranı',
        })
      ).statusCode,
    ).toBe(201);
    const zero = await verifiedRule(
      c,
      ruleInput({
        code: 'TEST-ZERO',
        config: { taxTreatment: 'zero', vatCode: 'KDV-0', exemptionCode: null },
      }),
    );
    const exempt = await verifiedRule(
      c,
      ruleInput({
        code: 'TEST-EXEMPT',
        config: { taxTreatment: 'exempt', vatCode: null, exemptionCode: 'TEST-EXEMPTION' },
      }),
    );
    const result = await c.post('/api/invoices', {
      type: 'sales',
      partyId: party.id,
      invoiceDate: '2026-10-01',
      post: true,
      lines: [zero, exempt, null].map((taxRuleId) => ({
        description: 'Karma satır',
        quantity: '1',
        unitPrice: '100',
        vatCode: 'KDV-20',
        taxRuleId,
        productClass: 'test-service',
        transactionType: 'domestic',
      })),
    });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().invoice).toMatchObject({
      netTotal: '300.0000',
      vatTotal: '20.0000',
      grossTotal: '320.0000',
    });
    expect(result.json().lines.map((line: { taxTreatment: string }) => line.taxTreatment)).toEqual([
      'zero',
      'exempt',
      'standard',
    ]);
  });
  it('belge damga tavanını satır sayısıyla çoğaltmaz ve son iadede kuruşları kapatır', async () => {
    const { c, party } = await setup();
    const capped = await verifiedRule(
      c,
      ruleInput({
        code: 'CAP',
        config: {
          taxTreatment: 'standard',
          vatCode: 'KDV-20',
          exemptionCode: null,
          stamp: {
            kind: 'percentage',
            ratePct: '1',
            basis: 'net',
            exemptAmount: '0',
            capAmount: '1.50',
          },
        },
      }),
    );
    const result = await c.post(
      '/api/invoices',
      invoiceInput(party.id, capped, {
        lines: [1, 2].map((index) => ({
          description: `Tavan satırı ${index}`,
          quantity: '1',
          unitPrice: '100',
          taxRuleId: capped,
          productClass: 'test-service',
          transactionType: 'domestic',
        })),
      }),
    );
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().invoice.taxTotalsSnapshot.stamp).toBe('1.50');
    expect(
      result
        .json()
        .lines.map((line: { taxCalculation: { stamp: string } }) => line.taxCalculation.stamp),
    ).toEqual(['0.75', '0.75']);
    const rounded = await verifiedRule(
      c,
      ruleInput({
        code: 'ROUND',
        config: {
          taxTreatment: 'standard',
          vatCode: 'KDV-20',
          exemptionCode: null,
          vatWithholding: { numerator: 1, denominator: 3 },
          incomeWithholding: { ratePct: '10', basis: 'net' },
          stamp: { kind: 'fixed', amount: '9.49' },
        },
      }),
    );
    const original = (await c.post('/api/invoices', invoiceInput(party.id, rounded))).json();
    const stamps: string[] = [],
      vats: string[] = [];
    for (let index = 0; index < 3; index++) {
      const returned = await c.post('/api/invoices', {
        type: 'sales_return',
        partyId: party.id,
        invoiceDate: '2026-10-02',
        returnOfId: original.invoice.id,
        post: true,
        lines: [
          {
            description: 'Kuruşlu iade',
            quantity: '1',
            unitPrice: '1000',
            sourceLineId: original.lines[0].id,
          },
        ],
      });
      expect(returned.statusCode, returned.body).toBe(201);
      stamps.push(returned.json().invoice.taxTotalsSnapshot.stamp);
      vats.push(returned.json().invoice.taxTotalsSnapshot.vatWithheld);
    }
    expect(stamps).toEqual(['3.16', '3.16', '3.17']);
    expect(vats).toEqual(['66.67', '66.67', '66.66']);
  });
  it('başka şirketin kuralını kullanmaz ve kesinleşmiş hesap görüntüsü değişmez', async () => {
    const a = await setup(),
      b = await setup();
    const id = await verifiedRule(a.c);
    const denied = await b.c.post('/api/invoices', invoiceInput(b.party.id, id));
    expect(denied.statusCode).toBe(404);
    const original = (await a.c.post('/api/invoices', invoiceInput(a.party.id, id))).json();
    await expect(
      asDb(fixture.handle, { userId: a.user.userId, companyId: a.company.id }, (q) =>
        q('update invoice_lines set tax_calculation=null where id=$1', [original.lines[0].id]),
      ),
    ).rejects.toBeDefined();
    await expect(
      asDb(fixture.handle, { userId: a.user.userId, companyId: a.company.id }, (q) =>
        q(
          'update document_tax_rules set config=config||\'{"vatCode":"KDV-10"}\'::jsonb where id=$1',
          [id],
        ),
      ),
    ).rejects.toBeDefined();
  });
  it('belge tutarını aşan kesintiyi anlaşılır doğrulama hatasıyla reddeder', async () => {
    const { c, party } = await setup();
    const id = await verifiedRule(c, ruleInput({
      code: 'EXCESS',
      config: { taxTreatment: 'standard', vatCode: 'KDV-20', exemptionCode: null,
        vatWithholding: { numerator: 7, denominator: 10 },
        incomeWithholding: { ratePct: '100', basis: 'gross' } },
    }));
    const rejected = await c.post('/api/invoices', invoiceInput(party.id, id));
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json().error.code).toBe('DOCUMENT_TAX_CALCULATION_INVALID');
    expect(rejected.json().error.message).toContain('belge tutarını aşamaz');
  });
  it('KDV dahil kuruşlu belgede gerçek satır KDV tutarını tevkifata taşır', async () => {
    const { c, party } = await setup();
    const id = await verifiedRule(c, ruleInput({ code: 'INCLUDED', config: {
      taxTreatment: 'standard', vatCode: 'KDV-1', exemptionCode: null,
      vatWithholding: { numerator: 7, denominator: 10 }, incomeWithholding: { ratePct: '10', basis: 'net' },
    } }));
    const result = await c.post('/api/invoices', invoiceInput(party.id, id, { vatIncluded: true,
      lines: [{ description: 'Kuruşlu dahil fiyat', quantity: '1', unitPrice: '0.50', taxRuleId: id, productClass: 'test-service', transactionType: 'domestic' }] }));
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().invoice).toMatchObject({ netTotal: '0.5000', vatTotal: '0.0000', grossTotal: '0.5000', taxTotalsSnapshot: { vatWithheld: '0.00', incomeWithheld: '0.05', payableToSeller: '0.45' } });
    expect(result.json().lines[0].taxCalculation).toMatchObject({ vat: '0.00', input: { vatAmount: '0.00' } });
    expect((await c.get(`/api/parties/${party.id}`)).json().summary.balance).toBe('0.4500');
  });
});
