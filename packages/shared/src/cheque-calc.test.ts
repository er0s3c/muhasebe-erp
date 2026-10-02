import { describe, expect, it } from 'vitest';
import {
  CHEQUE_ACTIONS,
  CHEQUE_STATUSES,
  allowedChequeActions,
  chequeTransition,
  guaranteeExpiryState,
  isOpenCheque,
  isValidChequeStatusChange,
  maturityBucket,
  type ChequeDirection,
} from './cheque-calc';
import { chequeActionSchema, createBankGuaranteeSchema, createChequeSchema } from './schemas/cheques';

const U1 = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const U2 = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

describe('çek/senet durum geçişleri', () => {
  it('alınan: portföy → tahsil/ciro/iade; tahsilde → tahsil edildi/karşılıksız; ciro → portföy', () => {
    expect(chequeTransition('received', 'deposit')).toEqual({ from: 'portfolio', to: 'in_collection' });
    expect(chequeTransition('received', 'collect')).toEqual({ from: 'in_collection', to: 'collected' });
    expect(chequeTransition('received', 'bounce')).toEqual({ from: 'in_collection', to: 'bounced' });
    expect(chequeTransition('received', 'endorse')).toEqual({ from: 'portfolio', to: 'endorsed' });
    expect(chequeTransition('received', 'unendorse')).toEqual({ from: 'endorsed', to: 'portfolio' });
    expect(chequeTransition('received', 'return')).toEqual({ from: 'portfolio', to: 'returned' });
    expect(chequeTransition('received', 'pay')).toBeNull();
    expect(chequeTransition('received', 'cancel')).toBeNull();
  });

  it('verilen: düzenlendi → ödendi/karşılıksız/iptal; alınana özgü eylemler yok', () => {
    expect(chequeTransition('issued', 'pay')).toEqual({ from: 'issued', to: 'paid' });
    expect(chequeTransition('issued', 'bounce')).toEqual({ from: 'issued', to: 'bounced' });
    expect(chequeTransition('issued', 'cancel')).toEqual({ from: 'issued', to: 'cancelled' });
    for (const a of ['deposit', 'collect', 'endorse', 'unendorse', 'return'] as const) expect(chequeTransition('issued', a)).toBeNull();
  });

  it('allowedChequeActions ve isValidChequeStatusChange aynı tabloyu kullanır; sonlanmış durumlardan çıkış yok', () => {
    expect(allowedChequeActions('received', 'portfolio').sort()).toEqual(['deposit', 'endorse', 'return']);
    expect(allowedChequeActions('received', 'in_collection').sort()).toEqual(['bounce', 'collect']);
    expect(allowedChequeActions('received', 'endorsed')).toEqual(['unendorse']);
    for (const s of ['collected', 'bounced', 'returned'] as const) expect(allowedChequeActions('received', s)).toEqual([]);
    for (const s of ['paid', 'bounced', 'cancelled'] as const) expect(allowedChequeActions('issued', s)).toEqual([]);
    for (const dir of ['received', 'issued'] as ChequeDirection[]) {
      for (const from of CHEQUE_STATUSES) {
        for (const to of CHEQUE_STATUSES) {
          const viaAction = CHEQUE_ACTIONS.some((a) => { const t = chequeTransition(dir, a); return t?.from === from && t.to === to; });
          expect(isValidChequeStatusChange(dir, from, to), `${dir} ${from}>${to}`).toBe(viaAction);
        }
      }
    }
  });

  it('açık belge: portföyde/tahsilde olan alınan, ödenmemiş verilen', () => {
    expect(isOpenCheque('received', 'portfolio')).toBe(true);
    expect(isOpenCheque('received', 'in_collection')).toBe(true);
    expect(isOpenCheque('received', 'endorsed')).toBe(false);
    expect(isOpenCheque('issued', 'issued')).toBe(true);
    expect(isOpenCheque('issued', 'paid')).toBe(false);
  });
});

describe('vade kovaları', () => {
  const b = (d: string) => maturityBucket(d, '2030-06-15');
  it('sınırlar dahil: 0–7, 8–30, 31–60, 61–90, 90+; geçmiş ayrı', () => {
    expect(b('2030-06-14')).toBe('overdue');
    expect(b('2030-06-15')).toBe('d0_7');
    expect(b('2030-06-22')).toBe('d0_7');
    expect(b('2030-06-23')).toBe('d8_30');
    expect(b('2030-07-15')).toBe('d8_30');
    expect(b('2030-07-16')).toBe('d31_60');
    expect(b('2030-08-14')).toBe('d31_60');
    expect(b('2030-08-15')).toBe('d61_90');
    expect(b('2030-09-13')).toBe('d61_90');
    expect(b('2030-09-14')).toBe('d90p');
  });
});

describe('teminat mektubu süre durumu', () => {
  const s = (expiry: string | null, warn: number | null) => guaranteeExpiryState(expiry, '2030-06-15', warn);
  it('uyarı günü yoksa dolmak üzere üretilmez; eşik dahil; süresiz mektup', () => {
    expect(s('2030-06-20', null)).toEqual({ state: 'ok', daysToExpiry: 5 });
    expect(s('2030-07-15', 30)).toEqual({ state: 'expiring', daysToExpiry: 30 });
    expect(s('2030-07-16', 30)).toEqual({ state: 'ok', daysToExpiry: 31 });
    expect(s('2030-06-15', 0)).toEqual({ state: 'expiring', daysToExpiry: 0 });
    expect(s('2030-06-14', null)).toEqual({ state: 'lapsed', daysToExpiry: -1 });
    expect(s(null, 30)).toEqual({ state: 'none', daysToExpiry: null });
  });
});

describe('çek/senet şemaları', () => {
  const base = { direction: 'received', docType: 'cheque', docNo: '1', partyId: U1, amount: '100', issueDate: '2030-01-01', dueDate: '2030-02-01' } as const;
  it('vade düzenlemeden önce olamaz; kalemler toplamı tutarı aşamaz; aynı kalem iki kez seçilemez', () => {
    expect(createChequeSchema.safeParse(base).success).toBe(true);
    expect(createChequeSchema.safeParse({ ...base, dueDate: '2029-12-31' }).success).toBe(false);
    expect(createChequeSchema.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(createChequeSchema.safeParse({ ...base, items: [{ lineId: U2, amount: '60', settleAmount: '60' }, { lineId: U2, amount: '10', settleAmount: '10' }] }).success).toBe(false);
    expect(createChequeSchema.safeParse({ ...base, items: [{ lineId: U2, amount: '101', settleAmount: '101' }] }).success).toBe(false);
    expect(createChequeSchema.safeParse({ ...base, items: [{ lineId: U2, amount: '100', settleAmount: '100' }] }).success).toBe(true);
  });

  it('eylem: banka yalnızca tahsile verme/ödemede, cari ve kalem yalnızca ciroda', () => {
    const a = { date: '2030-01-01', chequeIds: [U1] };
    expect(chequeActionSchema.safeParse({ ...a, action: 'deposit' }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, action: 'deposit', bankAccountId: U2 }).success).toBe(true);
    expect(chequeActionSchema.safeParse({ ...a, action: 'pay', bankAccountId: U2 }).success).toBe(true);
    expect(chequeActionSchema.safeParse({ ...a, action: 'collect', bankAccountId: U2 }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, action: 'endorse' }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, action: 'endorse', partyId: U2 }).success).toBe(true);
    expect(chequeActionSchema.safeParse({ ...a, action: 'return', partyId: U2 }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, action: 'return', items: [{ lineId: U2, amount: '1', settleAmount: '1' }] }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, chequeIds: [U1, U1], action: 'return' }).success).toBe(false);
    expect(chequeActionSchema.safeParse({ ...a, chequeIds: [], action: 'return' }).success).toBe(false);
  });

  it('teminat mektubu: cari ya da karşı taraf adı gerekli; komisyon oranı 0–100; son kullanma düzenlemeden önce olamaz', () => {
    const g = { direction: 'given', letterNo: 'M-1', bankName: 'B', counterpartyName: 'K', amount: '10', currencyCode: 'TRY', issueDate: '2030-01-01' } as const;
    expect(createBankGuaranteeSchema.safeParse(g).success).toBe(true);
    expect(createBankGuaranteeSchema.safeParse({ ...g, counterpartyName: undefined }).success).toBe(false);
    expect(createBankGuaranteeSchema.safeParse({ ...g, counterpartyName: undefined, partyId: U1 }).success).toBe(true);
    expect(createBankGuaranteeSchema.safeParse({ ...g, commissionRate: '100' }).success).toBe(true);
    expect(createBankGuaranteeSchema.safeParse({ ...g, commissionRate: '100.1' }).success).toBe(false);
    expect(createBankGuaranteeSchema.safeParse({ ...g, expiryDate: '2029-12-31' }).success).toBe(false);
  });
});
