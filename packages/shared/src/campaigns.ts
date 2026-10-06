import { z } from 'zod';
import { currencyCode,isoDate,uuid } from './schemas/common';
import { percentString } from './schemas/invoices';
import { dec,decCheck,roundMoney } from './money';
export const campaignSchema=z.object({
  code:z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/).transform(v=>v.toUpperCase()),
  title:z.string().trim().min(2).max(150),description:z.string().trim().max(1000).default(''),
  from:isoDate,to:isoDate,currency:currencyCode,discountPct:percentString.refine(decCheck(d=>d.gt(0)),'İndirim sıfırdan büyük olmalı'),
  minimumAmount:z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).default('0'),
  minimumQuantity:z.string().regex(/^\d{1,10}(\.\d{1,4})?$/).refine(decCheck(d=>d.gt(0))).default('1'),
  partyId:uuid.nullable().default(null),itemId:uuid.nullable().default(null),active:z.boolean().default(true),
}).refine(v=>v.to>=v.from,'Bitiş başlangıçtan önce olamaz');
export type Campaign=z.infer<typeof campaignSchema>;
export type CampaignRow=Campaign&{id:string;version:number;applications:number};
export type CampaignPreview={campaign:CampaignRow;fingerprint:string;eligible:boolean;reasons:string[];lines:{lineNo:number;description:string;discountPct:string;eligible:boolean}[];netBefore:string;netAfter:string;grossBefore:string;grossAfter:string;discountNet:string;currency:string};
export function evaluateCampaign(c:Campaign,invoice:{date:string;currency:string;partyId:string;lines:{itemId:string|null;quantity:string;unitPrice:string;discountPct:string}[]}){
  const reasons:string[]=[];
  if(!c.active)reasons.push('Kampanya pasif.');
  if(invoice.date<c.from||invoice.date>c.to)reasons.push('Fatura tarihi kampanya döneminde değil.');
  if(invoice.currency!==c.currency)reasons.push('Fatura para birimi kampanyayla eşleşmiyor.');
  if(c.partyId&&c.partyId!==invoice.partyId)reasons.push('Bu müşteri kampanya kapsamında değil.');
  const matches=invoice.lines.map(l=>(!c.itemId||l.itemId===c.itemId)&&dec(l.quantity).gte(c.minimumQuantity));
  const amount=invoice.lines.reduce((sum,l,i)=>matches[i]?sum.plus(dec(l.quantity).times(l.unitPrice)):sum,dec(0));
  if(!matches.some(Boolean))reasons.push('Ürün ve asgari miktar koşulunu sağlayan satır yok.');
  if(amount.lt(c.minimumAmount))reasons.push('Kapsamdaki satırların indirimsiz fiyat toplamı asgari tutardan az.');
  if(invoice.lines.some((l,i)=>matches[i]&&dec(l.discountPct).gt(0)))reasons.push('Kapsamdaki satırda indirim var; kampanyalar üst üste uygulanamaz.');
  return {eligible:!reasons.length,reasons,matches,amount:roundMoney(amount).toFixed(2)};
}
