import { describe, expect, it } from 'vitest';
import { daysBetween, foreignDocStatus, resolveDatedParam } from './foreign-calc';
import { createForeignDocSchema, createForeignParamSchema, createGuaranteeSchema, renewForeignDocSchema } from './schemas/foreignworkers';

/** Bu dosyadaki gün sayıları/tutarlar YALNIZCA TEST DEĞERİDİR (yasal değer değildir; kodda varsayılan yoktur). */
const TODAY = '2030-06-15';
const st = (expiryDate: string | null, warningDays: number | null, revoked = false) => foreignDocStatus({ expiryDate, revoked, today: TODAY, warningDays });

describe('belge durumu', () => {
  it('daysBetween takvim günü sayar (ay/yıl/artık yıl sınırları)', () => {
    expect(daysBetween('2030-06-15', '2030-06-15')).toBe(0);
    expect(daysBetween('2030-02-28', '2030-03-01')).toBe(1);
    expect(daysBetween('2032-02-28', '2032-03-01')).toBe(2);
    expect(daysBetween('2030-12-31', '2031-01-01')).toBe(1);
    expect(daysBetween('2030-06-20', '2030-06-15')).toBe(-5);
  });

  it('son kullanma günü dahil geçerli; ertesi gün süresi dolmuş', () => {
    expect(st('2030-06-15', null)).toEqual({ status: 'valid', daysToExpiry: 0 });
    expect(st('2030-06-14', null)).toEqual({ status: 'expired', daysToExpiry: -1 });
  });

  it('uyarı günü: eşik dahil dolmak üzere; eşiğin dışı geçerli', () => {
    expect(st('2030-07-15', 30)).toEqual({ status: 'expiring', daysToExpiry: 30 });
    expect(st('2030-07-16', 30)).toEqual({ status: 'valid', daysToExpiry: 31 });
    expect(st('2030-06-15', 0).status).toBe('expiring');
    expect(st('2030-06-14', 30).status).toBe('expired');
  });

  it('uyarı parametresi yoksa dolmak üzere üretilmez', () => {
    expect(st('2030-06-16', null).status).toBe('valid');
  });

  it('iptal her şeyi geçer; süresiz belge geçerli', () => {
    expect(st('2030-06-14', 30, true).status).toBe('revoked');
    expect(st(null, 30)).toEqual({ status: 'valid', daysToExpiry: null });
    expect(st(null, 30, true).status).toBe('revoked');
  });
});

describe('tarihli parametre çözümü', () => {
  const rows = [
    { key: 'k', effectiveFrom: '2030-01-01', enabled: true, value: '10' },
    { key: 'k', effectiveFrom: '2030-06-01', enabled: true, value: '20' },
    { key: 'k', effectiveFrom: '2031-01-01', enabled: false, value: '30' },
    { key: 'z', effectiveFrom: '2030-01-01', enabled: false, value: '99' },
  ];
  it('en yeni başlangıç geçerlidir; gelecekteki satır sayılmaz', () => {
    expect(resolveDatedParam(rows, 'k', '2030-05-31')?.value).toBe('10');
    expect(resolveDatedParam(rows, 'k', '2030-06-01')?.value).toBe('20');
    expect(resolveDatedParam(rows, 'k', '2030-12-31')?.value).toBe('20');
  });
  it('en yeni satır kapalıysa parametre kapalıdır; satır yoksa ya da başlangıçtan önceyse null', () => {
    expect(resolveDatedParam(rows, 'k', '2031-02-01')).toBeNull();
    expect(resolveDatedParam(rows, 'z', '2030-06-01')).toBeNull();
    expect(resolveDatedParam(rows, 'k', '2029-12-31')).toBeNull();
    expect(resolveDatedParam([], 'k', TODAY)).toBeNull();
  });
});

describe('şemalar', () => {
  const U = '0198f2c4-7b1a-7000-8000-000000000001';
  it('parametre: varsayılan kapalı; teminat için para birimi zorunlu, uyarı günü için yasak', () => {
    expect(createForeignParamSchema.parse({ key: 'guarantee_amount', value: '100', currency: 'EUR', effectiveFrom: '2030-01-01' }).enabled).toBe(false);
    expect(createForeignParamSchema.safeParse({ key: 'guarantee_amount', value: '100', effectiveFrom: '2030-01-01' }).success).toBe(false);
    expect(createForeignParamSchema.safeParse({ key: 'guarantee_amount', value: '0', currency: 'EUR', effectiveFrom: '2030-01-01' }).success).toBe(false);
    expect(createForeignParamSchema.safeParse({ key: 'expiry_warning_days', value: '30', currency: 'EUR', effectiveFrom: '2030-01-01' }).success).toBe(false);
    expect(createForeignParamSchema.safeParse({ key: 'expiry_warning_days', value: '30.5', effectiveFrom: '2030-01-01' }).success).toBe(false);
    expect(createForeignParamSchema.safeParse({ key: 'expiry_warning_days', value: '30', effectiveFrom: '2030-01-01' }).success).toBe(true);
  });
  it('belge ve yenileme tarihleri tutarlı olmalı; teminat isteğinde tutar alanı yoktur', () => {
    expect(createForeignDocSchema.safeParse({ employeeId: U, typeId: U, issueDate: '2030-02-01', expiryDate: '2030-01-01' }).success).toBe(false);
    expect(renewForeignDocSchema.safeParse({ issueDate: '2030-02-01', expiryDate: '2030-01-01' }).success).toBe(false);
    expect(Object.keys(createGuaranteeSchema.parse({ employeeId: U, depositedDate: '2030-01-01', amount: '250' }))).not.toContain('amount');
  });
});
