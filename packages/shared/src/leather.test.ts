import { describe, expect, it } from 'vitest';
import { assertLeatherAreaConservation, leatherAreaToM2, leatherCompletionShare, leatherQualitySchema, leatherOperationSchema, splitLeatherCostDelta } from './leather';
const id='11111111-1111-4111-8111-111111111111';
describe('deri fiziksel ölçü ve ağırlıklı ortalama maliyet payı',()=>{
 it('m², dm² ve ft² ölçülerini tek temel stok birimine çevirir',()=>{expect(leatherAreaToM2('100','dm2')).toBe('1.0000');expect(leatherAreaToM2('10','ft2')).toBe('0.9290');expect(leatherAreaToM2('1.2345','m2')).toBe('1.2345');});
 it('başlangıç alanını tüketim, normal fire ve kalanlar arasında korur',()=>{
  expect(()=>assertLeatherAreaConservation('10','6.125','0.875',['2','1'])).not.toThrow();
  expect(()=>assertLeatherAreaConservation('10','6','1',['2'])).toThrow();
 });
 it('kısmi mamul kabulü kalan plan oranını, açık kapanış kalan WIP tamamını alır',()=>{
  expect(leatherCompletionShare('10','16').toString()).toBe('0.625');
  expect(leatherCompletionShare('3','6',true).toString()).toBe('1');
  expect(()=>leatherCompletionShare('7','6')).toThrow();
 });
 it('geç gelen maliyet hammadde/WIP/mamul/satılmış paylarına 200/300/250/250 dağılır',()=>{
  const weights=[{key:'raw',share:'.2'},{key:'wip',share:'.3'},{key:'finished',share:'.25'},{key:'sold',share:'.25'}];
  expect(splitLeatherCostDelta('1000',weights).map(x=>x.amount)).toEqual(['200.00','300.00','250.00','250.00']);
  expect(splitLeatherCostDelta('-1000',weights).map(x=>x.amount)).toEqual(['-200.00','-300.00','-250.00','-250.00']);
  expect(splitLeatherCostDelta('.01',weights).reduce((n,x)=>n+Number(x.amount),0)).toBeCloseTo(.01);
 });
 it('bozuk ondalık kalite ve operasyon girdileri throw yerine doğrulama hatası verir',()=>{
  const q={scope:'production',sourceId:id,stage:'final',inspectedQty:'2',passedQty:'1,5',scrapQty:'.5',checks:[{label:'Dikiş',passed:true}]};
  expect(()=>leatherQualitySchema.safeParse(q)).not.toThrow();expect(leatherQualitySchema.safeParse(q).success).toBe(false);
  expect(()=>leatherOperationSchema.safeParse({date:'2026-10-07',requestKey:id,key:'stitching',status:'completed',quantity:'2',goodQty:'1,5'})).not.toThrow();
 });
});
