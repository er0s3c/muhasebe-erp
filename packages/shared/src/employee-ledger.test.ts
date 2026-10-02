import { describe, expect, it } from 'vitest';
import { advanceDeductionCap, advanceStatusFor, allocateDeductionFifo, buildEmployeeStatement, employeeBalance } from './employee-ledger';

describe('personel avans durumu', () => {
  it('kapanan tutardan türetilir', () => {
    expect(advanceStatusFor('1000.00', '0')).toBe('open');
    expect(advanceStatusFor('1000.00', '0.01')).toBe('partial');
    expect(advanceStatusFor('1000.00', '999.99')).toBe('partial');
    expect(advanceStatusFor('1000.00', '1000')).toBe('settled');
  });
});

describe('personel bakiyesi', () => {
  it('avans kesilince bakiye çift sayılmaz: net ücret zaten kesinti sonrasıdır', () => {
    // 1000 avans; bordro: kesinti öncesi 5000, 1000 kesinti → net 4000 (şirket personele 4000 borçlu)
    const b = employeeBalance({ salaryNet: '4000', salaryPaid: '0', advanceGiven: '1000', advanceDeducted: '1000', advanceRepaid: '0' });
    expect(b).toEqual({ net: '4000.00', openAdvance: '0.00', unpaidSalary: '4000.00' });
    expect(employeeBalance({ salaryNet: '4000', salaryPaid: '4000', advanceGiven: '1000', advanceDeducted: '1000', advanceRepaid: '0' }).net).toBe('0.00');
  });

  it('yalnız açık avans varsa personel şirkete borçludur (negatif net)', () => {
    expect(employeeBalance({ salaryNet: '0', salaryPaid: '0', advanceGiven: '700', advanceDeducted: '0', advanceRepaid: '200' })).toEqual({ net: '-500.00', openAdvance: '500.00', unpaidSalary: '0.00' });
  });
});

describe('personel ekstresi', () => {
  it('yürüyen bakiye alacak − borç; aynı gün sırası belirli', () => {
    const st = buildEmployeeStatement('0', [
      { date: '2026-02-10', kind: 'advance', ref: 'AVN-1', description: 'Avans', amount: '1000' },
      { date: '2026-02-28', kind: 'salary_net', ref: 'BRD-1', description: 'Net', amount: '4000' },
      { date: '2026-02-28', kind: 'advance_deduction', ref: 'AVN-1', description: 'Kesinti', amount: '1000' },
      { date: '2026-03-05', kind: 'salary_payment', ref: 'KB-1', description: 'Ödeme', amount: '4000' },
    ]);
    expect(st.lines.map((l) => l.balance)).toEqual(['-1000.00', '0.00', '4000.00', '0.00']);
    expect(st.closing).toBe('0.00');
    expect(st.totals).toEqual({ debit: '5000.00', credit: '5000.00' });
  });

  it('açılış bakiyesi taşınır', () => {
    const st = buildEmployeeStatement('250.50', [{ date: '2026-01-01', kind: 'salary_payment', ref: 'x', description: '', amount: '50.50' }]);
    expect(st.closing).toBe('200.00');
  });
});

describe('avans kesintisi üst sınırı (kullanıcı parametresi)', () => {
  it('parametre yoksa sınır yoktur; varsa kesinti öncesi netin yüzdesi, kuruşa yuvarlanır', () => {
    expect(advanceDeductionCap('5000', null)).toBeNull();
    expect(advanceDeductionCap('5000', undefined)).toBeNull();
    expect(advanceDeductionCap('5000', '0')).toBeNull();
    expect(advanceDeductionCap('5000', '25')?.toFixed(2)).toBe('1250.00');
    expect(advanceDeductionCap('1000.01', '33.3333')?.toFixed(2)).toBe('333.34');
  });
});

describe('FIFO kesinti dağıtımı', () => {
  it('en eski avanstan başlar, kalan avansı aşmaz', () => {
    const r = allocateDeductionFifo([{ id: 'a', remaining: '300' }, { id: 'b', remaining: '500' }], '600');
    expect(r.parts).toEqual([{ advanceId: 'a', amount: '300.00' }, { advanceId: 'b', amount: '300.00' }]);
    expect(r.rest).toBe('0.00');
    expect(allocateDeductionFifo([{ id: 'a', remaining: '100' }], '250').rest).toBe('150.00');
  });
});
