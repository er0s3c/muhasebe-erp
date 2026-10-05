import { z } from 'zod';
import { isoDate, moneyString, currencyCode, uuid } from './schemas/common';

export const OPERATION_KINDS=['collection','site_report','schedule','equipment','equipment_log','defect'] as const;
export const operationKindSchema=z.enum(OPERATION_KINDS);
export type OperationKind=z.infer<typeof operationKindSchema>;
const note=z.string().trim().max(4000).default('');
export const operationPayloads={
  collection:z.object({promiseAmount:moneyString,currency:currencyCode,promiseDate:isoDate,contactNote:note}),
  site_report:z.object({weather:z.string().trim().max(100).default(''),workers:z.number().int().min(0).max(100000),workDone:note,issues:note}),
  schedule:z.object({start:isoDate,end:isoDate,progress:z.number().min(0).max(100),dependencies:z.array(uuid).max(100).default([])}).refine(v=>v.start<=v.end,'Bitiş başlangıçtan önce olamaz.'),
  equipment:z.object({code:z.string().trim().min(1).max(60),category:z.enum(['vehicle','machine','tool']),serial:z.string().trim().max(100).default(''),nextMaintenance:isoDate.optional()}),
  equipment_log:z.object({equipmentId:uuid,hours:z.number().min(0).max(24),fuelLiters:moneyString,cost:moneyString,currency:currencyCode,expenseType:z.enum(['fuel','maintenance','rent','other']),invoiceId:uuid.optional()}),
  defect:z.object({unitId:uuid,location:z.string().trim().min(1).max(200),contractorId:uuid.optional(),resolution:note}),
} as const;
export const operationSchema=z.object({
  id:uuid.optional(),kind:operationKindSchema,title:z.string().trim().min(2).max(200),
  projectId:uuid.optional(),partyId:uuid.optional(),ownerId:uuid.optional(),eventDate:isoDate,dueDate:isoDate,
  payload:z.record(z.string(),z.unknown()),
}).superRefine((v,ctx)=>{
  const parsed=operationPayloads[v.kind].safeParse(v.payload);
  if(!parsed.success) for(const issue of parsed.error.issues) ctx.addIssue({code:'custom',path:['payload',...issue.path],message:issue.message});
  if(v.kind==='collection'&&!v.partyId)ctx.addIssue({code:'custom',path:['partyId'],message:'Cari seçin.'});
  if(v.kind!=='collection'&&!v.projectId)ctx.addIssue({code:'custom',path:['projectId'],message:'Proje seçin.'});
});
export type OperationInput=z.infer<typeof operationSchema>;
export type OperationRow={id:string;kind:OperationKind;title:string;projectId:string|null;partyId:string|null;ownerId:string;ownerName:string;eventDate:string;dueDate:string;payload:Record<string,unknown>;status:'open'|'done'|'cancelled';version:number;createdBy:string};

/** Finish-to-start dependencies; UTC day arithmetic avoids DST-dependent duration. */
export function scheduleImpact(items:{id:string;start:string;end:string;progress:number;dependencies:string[]}[],today:string) {
  const byId=new Map(items.map(i=>[i.id,i]));
  const results=new Map<string,{id:string;forecastEnd:string;delayDays:number}>();
  const visiting=new Set<string>();
  const day=(s:string)=>Date.parse(`${s}T00:00:00Z`)/86400000;
  const iso=(d:number)=>new Date(d*86400000).toISOString().slice(0,10);
  function visit(id:string):{id:string;forecastEnd:string;delayDays:number} {
    const cached=results.get(id);if(cached)return cached;
    const item=byId.get(id);if(!item)throw new Error('Bağımlı iş aynı projede bulunamadı.');
    if(visiting.has(id))throw new Error('İş bağımlılıkları döngü içeriyor.');
    visiting.add(id);
    const dependencies=item.dependencies.map(visit);
    const duration=Math.max(1,day(item.end)-day(item.start)+1);
    const remaining=Math.max(1,Math.ceil(duration*(100-item.progress)/100));
    const start=Math.max(day(item.start),day(today),...dependencies.map(d=>day(d.forecastEnd)+1));
    const end=item.progress===100?day(item.end):Math.max(day(item.end),start+remaining-1);
    const result={id,forecastEnd:iso(end),delayDays:Math.max(0,end-day(item.end))};
    visiting.delete(id);results.set(id,result);return result;
  }
  return items.map(i=>visit(i.id));
}
