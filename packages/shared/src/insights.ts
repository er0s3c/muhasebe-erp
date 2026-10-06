import { z } from 'zod';
import { isoDate } from './schemas/common';
export const insightKeys=['sales-report','purchase-report','trial-balance','stock-status','party-aging','project-profitability','cheque-maturity','cash-forecast'] as const;
export const insightConfigSchema=z.object({
  title:z.string().trim().min(2).max(150),reportKey:z.enum(insightKeys),
  range:z.enum(['month','year','fixed']).default('month'),from:isoDate,to:isoDate,
  options:z.object({groupBy:z.enum(['party','item','month','invoice']).optional(),type:z.enum(['receivable','payable']).optional()}).default({}),
  chart:z.object({tableKey:z.string().max(100),labelKey:z.string().max(100),valueKey:z.string().max(100)}).nullable().default(null),
  shared:z.boolean().default(false),position:z.number().int().min(0).max(10000).default(0),
}).refine(v=>v.to>=v.from&&Date.parse(v.to)-Date.parse(v.from)<=366*86400000,'Rapor aralığı en fazla 367 gün olmalı.');
export type InsightConfig=z.infer<typeof insightConfigSchema>;
export type SavedInsight=InsightConfig&{id:string;createdBy:string;version:number};
export type InsightTable={key:string;title:string;subtitle?:string;columns:{key:string;label:string;kind:'text'|'money'|'date'|'qty'|'rate'|'int';currency?:string}[];rows:Record<string,string|number|null>[];totals?:Record<string,string|number|null>;rowCount:number};
export type InsightResult={tables:InsightTable[];range:{from:string;to:string};chart:{label:string;value:string;share:number}[];chartLabel:string|null;chartCurrency:string|null;chartError:string|null};
