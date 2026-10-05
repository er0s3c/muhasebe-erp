import { describe,it,expect } from 'vitest';
import { scheduleImpact,operationSchema } from './operations';
import { projectCashScenario } from './cash-scenario';
describe('İş programı ve nakit senaryoları',()=>{
  it('gecikmeyi bağlı işlere taşır, tamamlanmış işi uzatmaz',()=>{
    const result=scheduleImpact([{id:'a',start:'2026-10-01',end:'2026-10-05',progress:50,dependencies:[]},{id:'b',start:'2026-10-06',end:'2026-10-08',progress:0,dependencies:['a']},{id:'c',start:'2026-09-01',end:'2026-09-02',progress:100,dependencies:[]}],'2026-10-10');
    expect(result[0]).toEqual({id:'a',forecastEnd:'2026-10-12',delayDays:7});
    expect(result[1]).toEqual({id:'b',forecastEnd:'2026-10-15',delayDays:7});
    expect(result[2]?.delayDays).toBe(0);
  });
  it('döngü ve eksik bağımlılığı reddeder',()=>{
    const item={start:'2026-10-01',end:'2026-10-02',progress:0};
    expect(()=>scheduleImpact([{...item,id:'a',dependencies:['b']},{...item,id:'b',dependencies:['a']}],'2026-10-01')).toThrow('döngü');
    expect(()=>scheduleImpact([{...item,id:'a',dependencies:['missing']}],'2026-10-01')).toThrow('bulunamadı');
  });
  it('vadesi geçmiş girişe bugünden gecikme uygular ve dönem dışı tutarı açıklar',()=>{
    const source={from:'2026-10-01',weeks:1,opening:'100',later:{receivables:'40',payables:'0'},items:[{date:'2026-09-01',direction:'in' as const,amountBase:'50'},{date:'2026-10-02',direction:'out' as const,amountBase:'20'}]};
    const result=projectCashScenario(source,{delayDays:10,outflowIncreasePct:15});
    expect(result.closing).toBe('77.00');expect(result.movedBeyondHorizon.inflow).toBe('50.00');expect(result.baselineBeyondHorizon.receivables).toBe('40');expect(source.items[1]?.amountBase).toBe('20');
  });
  it('şema yanlış türde alanları ve projesiz saha kaydını reddeder',()=>{
    expect(operationSchema.safeParse({kind:'site_report',title:'Saha',eventDate:'2026-10-01',dueDate:'2026-10-01',payload:{workers:-1}}).success).toBe(false);
  });
});
