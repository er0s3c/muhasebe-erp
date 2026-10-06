import { describe,it,expect } from 'vitest';
import { recurrenceSchema,occurrenceDate } from './recurring';
describe('Tekrar takvimi',()=>{
  it('ay sonunu, çeyreği ve artık yılı başlangıç gününe bağlı tutar',()=>{
    const monthly=recurrenceSchema.parse({startDate:'2027-01-31'});
    expect([0,1,2,3].map(i=>occurrenceDate(monthly,i))).toEqual(['2027-01-31','2027-02-28','2027-03-31','2027-04-30']);
    expect(occurrenceDate({...monthly,frequency:'quarterly'},1)).toBe('2027-04-30');
    const yearly=recurrenceSchema.parse({startDate:'2024-02-29',frequency:'yearly'});
    expect(occurrenceDate(yearly,1)).toBe('2025-02-28');expect(occurrenceDate(yearly,4)).toBe('2028-02-29');
  });
  it('hafta aralığı ve tarih/sayaç sınırları doğrulanır',()=>{
    expect(occurrenceDate(recurrenceSchema.parse({startDate:'2026-12-28',frequency:'weekly',interval:2}),1)).toBe('2027-01-11');
    expect(recurrenceSchema.safeParse({startDate:'2026-01-10',endDate:'2026-01-09'}).success).toBe(false);
    expect(()=>occurrenceDate(recurrenceSchema.parse({startDate:'2026-01-01'}),-1)).toThrow();
  });
});
