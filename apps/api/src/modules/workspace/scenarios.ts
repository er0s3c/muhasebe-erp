import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { cashScenarioSchema,projectCashScenario } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { cashForecast } from '../cash/forecast';
export const scenarioRoutes:FastifyPluginAsync=async app=>{
  const read={module:'core.treasury',permission:'treasury.read'} as const;
  app.get('/api/workspace/cash-scenarios',tenantRoute(app,read,async c=>({items:(await c.tx.execute(sql`select id,name,assumptions,created_at as "createdAt" from cash_scenarios order by created_at desc limit 100`)).rows})));
  app.post('/api/workspace/cash-scenarios',tenantRoute(app,{module:'core.treasury',permission:'treasury.manage'},async c=>{
    const input=cashScenarioSchema.parse(c.req.body);const id=uuidv7();
    await c.tx.execute(sql`insert into cash_scenarios(id,company_id,name,assumptions,created_by) values(${id},${c.company.id},${input.name},${JSON.stringify(input)}::jsonb,${c.user.id})`);
    void c.reply.code(201);return {id};
  }));
  app.post('/api/workspace/cash-scenarios/preview',tenantRoute(app,read,async c=>{
    const input=cashScenarioSchema.parse(c.req.body);
    const baseline=await cashForecast(c.tx,{companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency},{weeks:input.weeks});
    return {assumptions:input,baseline,scenario:projectCashScenario(baseline,input)};
  }));
};
