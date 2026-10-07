import { describe, expect, it } from 'vitest';
import { closePosSessionSchema, createPosTillSchema, posExpectedCash, posSaleSchema } from './pos';
const id='11111111-1111-4111-8111-111111111111';
describe('mağaza POS doğrulaması',()=>{
  it('parçalı ödemede nakit ve iadeyi kasaya, kartı banka hesabına ayırır',()=>{
    expect(posExpectedCash('100',[{kind:'sale',payments:[{method:'cash',amount:'50'},{method:'card',amount:'200'}]},{kind:'return',payments:[{method:'cash',amount:'20'},{method:'card',amount:'30'}]}])).toBe('130.00');
  });
  it('tutar, kimlik, iskonto ve atama girdilerini güvenli doğrular',()=>{
    expect(createPosTillSchema.safeParse({name:'Kasa',warehouseId:id,cashAccountId:id,assignedUserIds:[],maxDiscountPct:'1,5'}).success).toBe(false);
    expect(posSaleSchema.safeParse({requestId:id,lines:[{itemId:id,quantity:'1',discountPct:'101'}],payments:[{method:'cash',amount:'100'}]}).success).toBe(false);
    expect(closePosSessionSchema.safeParse({countedCash:'-1'}).success).toBe(false);
  });
});
