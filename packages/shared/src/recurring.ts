import { z } from 'zod';
import { isoDate,uuid } from './schemas/common';
import { addDaysIso } from './dates';
import { createAgendaSchema } from './schemas/directory';

export const recurrenceSchema=z.object({
  startDate:isoDate,endDate:isoDate.nullable().default(null),
  frequency:z.enum(['daily','weekly','monthly','quarterly','yearly']).default('monthly'),
  interval:z.number().int().min(1).max(30).default(1),
}).refine(v=>!v.endDate || v.endDate>=v.startDate,'Bitiş tarihi başlangıçtan önce olamaz.');
export type Recurrence=z.infer<typeof recurrenceSchema>;
export const recurringCreateSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('agenda'),title:z.string().trim().min(2).max(200),recurrence:recurrenceSchema,agenda:createAgendaSchema}),
  z.object({kind:z.literal('invoice'),title:z.string().trim().min(2).max(200),recurrence:recurrenceSchema,sourceInvoiceId:uuid,dueDays:z.number().int().min(0).max(365).default(30)}),
]);
/** Monthly dates retain their original day (31 Jan → 28 Feb → 31 Mar). */
export function occurrenceDate(rule:Recurrence,index:number) {
  if(!Number.isSafeInteger(index)||index<0||index>100000) throw new Error('Geçersiz tekrar sırası.');
  const step=index*rule.interval;
  if(rule.frequency==='daily'||rule.frequency==='weekly') return addDaysIso(rule.startDate,step*(rule.frequency==='weekly'?7:1));
  const [year,month,day]=rule.startDate.split('-').map(Number) as [number,number,number];
  const months=step*(rule.frequency==='monthly'?1:rule.frequency==='quarterly'?3:12);
  const target=new Date(Date.UTC(year,month-1+months,1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,last));
  return target.toISOString().slice(0,10);
}
export type RecurringTemplate={id:string;kind:'agenda'|'invoice';title:string;recurrence:Recurrence;status:'active'|'paused'|'finished';nextDate:string|null;generated:number;version:number;createdBy:string;error:string|null;payload:Record<string,unknown>};
