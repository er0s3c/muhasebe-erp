import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { errorFix, permissionBlocker } from './blockers';

const allow = (...permissions: string[]) => (permission: string) => permissions.includes(permission);
const err = (code: string, details?: unknown) => new ApiError(422, code, 'sunucu mesajı', details);
const ID = '01a12a27-cb09-7789-95fc-54e42176f372';

describe('engel nedeni ve çözüm bağlantısı (öneri 28)', () => {
  it('kapalı dönem: yetkiliye ilgili yılın dönem ekranı, diğerine kime başvuracağı', () => {
    expect(errorFix(err('PERIOD_CLOSED', { year: 2026, month: 3 }), allow('ledger.close_period'))).toEqual({ fix: { label: 'Mali dönemleri aç', to: '/settings/periods?year=2026' } });
    expect(errorFix(err('PERIOD_CLOSED', { year: 2026 }), allow())).toEqual({ ask: expect.stringContaining('muhasebe yöneticinize') });
    expect(errorFix(err('PERIOD_MISSING', { year: 'x' }), allow('settings.manage'))!.fix!.to).toBe('/settings/periods');
  });
  it('iadesi veya tahsilatı olan fatura: engelleyen belgeye gider', () => {
    expect(errorFix(err('INVOICE_HAS_RETURNS', { invoiceId: ID, invoiceNo: 'SIF-2026-000001' }), allow())).toEqual({ fix: { label: 'SIF-2026-000001 faturasını aç', to: `/invoices/${ID}` } });
    const payments = err('INVOICE_HAS_PAYMENTS', { settlements: [{ kind: 'cheque', id: ID, ref: '12' }, { kind: 'treasury', id: ID, ref: 'TAH-2026-000003' }] });
    expect(errorFix(payments, allow('treasury.read'))!.fix).toEqual({ label: 'TAH-2026-000003 hareketini aç', to: `/treasury/transactions?open=${ID}` });
    // Kasa/banka ekranını göremeyen kullanıcıya bağlantı verilmez
    expect(errorFix(payments, allow())).toBeNull();
  });
  it('ekstreyle eşleşmiş hareket banka ekstresi sekmesine gider; bozuk ayrıntı bağlantı üretmez', () => {
    expect(errorFix(err('TXN_RECONCILED', { accountId: ID }), allow())!.fix!.to).toBe(`/treasury/accounts/${ID}?tab=bank`);
    expect(errorFix(err('TXN_RECONCILED', { accountId: '../../x' }), allow())).toBeNull();
    expect(errorFix(err('INVOICE_HAS_RETURNS'), allow())).toBeNull();
  });
  it('yetki ve modül engelleri; ilgisiz hatalar', () => {
    expect(errorFix(err('MODULE_READ_ONLY'), allow())).toEqual({ ask: expect.stringContaining('yöneticinize') });
    expect(errorFix(err('MODULE_DISABLED'), allow('settings.manage'))!.fix!.to).toBe('/settings/modules');
    expect(errorFix(err('VALIDATION_ERROR'), allow())).toBeNull();
    expect(errorFix(new Error('ağ'), allow())).toBeNull();
    expect(permissionBlocker('Faturayı iptal etmek', allow('members.manage')).fix!.to).toBe('/settings/members');
    expect(permissionBlocker('Faturayı iptal etmek', allow())).toMatchObject({ reason: 'Faturayı iptal etmek için yetkiniz yok.', ask: expect.any(String) });
  });
});
