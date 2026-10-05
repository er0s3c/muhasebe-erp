import type { FastifyPluginAsync } from 'fastify';
import { randomBytes,createHash } from 'node:crypto';
import { hash,verify } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { idParam,resolveEnabledModules,todayIso,type Sector } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { setContext,withContext } from '../../db/client';
import { AppError,notFound,unauthorized } from '../../http/errors';
import { requireRecord } from './records';
import { partyOpenItems } from '../parties/service';

const credentials=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(12).max(128),documentId:z.uuid().optional()});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const portalRoutes:FastifyPluginAsync=async app=>{
  const manage={module:'core.parties',permission:'members.manage'} as const;
  app.get('/api/workspace/portal-links',tenantRoute(app,manage,async c=>({items:(await c.tx.execute(sql`select l.id,l.label,l.party_id as "partyId",p.name as "partyName",l.expires_at as "expiresAt",l.revoked_at as "revokedAt" from portal_links l join parties p on p.id=l.party_id order by l.created_at desc limit 100`)).rows})));
  app.post('/api/workspace/portal-links',tenantRoute(app,manage,async c=>{
    const input=z.object({partyId:z.uuid(),label:z.string().trim().min(2).max(120),password:z.string().min(12).max(128),days:z.number().int().min(1).max(30),documentIds:z.array(z.uuid()).max(50).default([])}).parse(c.req.body);
    await requireRecord(c,'party',input.partyId);
    for(const id of input.documentIds){const r=await c.tx.execute(sql`select id from record_documents where id=${id}::uuid and record_kind='party' and record_id=${input.partyId}::uuid`);if(!r.rows.length)throw notFound('Paylaşılacak cari belgesi');}
    const token=randomBytes(32).toString('base64url');const id=uuidv7();const passwordHash=await hash(input.password);
    await c.tx.execute(sql`insert into portal_links(id,company_id,org_id,party_id,label,token_hash,password_hash,expires_at,created_by,document_ids)
      values(${id},${c.company.id},${c.user.orgId},${input.partyId},${input.label},${digest(token)},${passwordHash},now()+${input.days}*interval '1 day',${c.user.id},${`{${input.documentIds.join(',')}}`}::uuid[])`);
    await c.tx.execute(sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${c.company.id},${id},'created')`);
    void c.reply.code(201);return {id,token};
  }));
  app.post('/api/workspace/portal-links/:id/revoke',tenantRoute(app,manage,async c=>{
    const {id}=idParam.parse(c.req.params);const result=await c.tx.execute(sql`update portal_links set revoked_at=now() where id=${id}::uuid returning id`);
    if(!result.rows.length)throw notFound();
    await c.tx.execute(sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${c.company.id},${id},'revoked')`);
    return {ok:true};
  }));
  // External authentication is independent of staff sessions: secret + password, with expiry and revocation.
  app.post('/api/portal/view',async (req,reply)=>{
    const budget=app.limiter.consume(`portal:${req.ip}`,20,60_000);
    if(!budget.ok){void reply.header('retry-after',String(budget.retryAfterSec));throw new AppError(429,'RATE_LIMITED','Çok fazla deneme. Biraz sonra tekrar deneyin.');}
    const parsed=credentials.safeParse(req.body);if(!parsed.success)throw unauthorized('Portal erişimi doğrulanamadı.');
    const input=parsed.data;
    return withContext(app.db,{},async tx=>{
      await tx.execute(sql`select set_config('app.portal_hash',${digest(input.token)},true)`);
      const rows=await tx.execute<{id:string;company_id:string;org_id:string;party_id:string;created_by:string;password_hash:string;document_ids:string[]}>(sql`select id,company_id,org_id,party_id,created_by,password_hash,document_ids from portal_links where token_hash=${digest(input.token)} and revoked_at is null and expires_at>now()`);
      const link=rows.rows[0];if(!link||!await verify(link.password_hash,input.password))throw unauthorized('Portal erişimi doğrulanamadı.');
      await setContext(tx,{companyId:link.company_id,orgId:link.org_id,userId:link.created_by,ip:req.ip});
      const issuer=await tx.execute(sql`select 1 from memberships m join users u on u.id=m.user_id where m.company_id=${link.company_id}::uuid and m.user_id=${link.created_by}::uuid and m.role in ('owner','admin') and u.is_active`);
      if(!issuer.rows.length)throw unauthorized('Portal erişimi kapatılmış.');
      const companies=await tx.execute<{name:string;sector:Sector}>(sql`select name,sector from companies where id=${link.company_id}::uuid`);
      const company=companies.rows[0];if(!company)throw unauthorized();
      const overrides=await tx.execute<{module:string;enabled:boolean}>(sql`select module,enabled from company_modules`);
      const modules=resolveEnabledModules(company.sector,overrides.rows);
      if(!modules.has('core.parties'))throw unauthorized('Portal erişimi kapatılmış.');
      await tx.execute(sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${link.company_id},${link.id},${input.documentId?'download':'view'})`);
      if(input.documentId){
        if(!link.document_ids.includes(input.documentId))throw notFound();
        const docs=await tx.execute<{filename:string;mime:string;content:string}>(sql`select d.filename,d.mime,b.content from record_documents d join record_document_content b on b.id=d.id where d.id=${input.documentId}::uuid and d.record_kind='party' and d.record_id=${link.party_id}::uuid`);
        const doc=docs.rows[0];if(!doc)throw notFound();return reply.header('content-type',doc.mime).header('content-disposition',`attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`).header('cache-control','no-store').send(Buffer.from(doc.content,'base64'));
      }
      const parties=await tx.execute<{name:string;code:string}>(sql`select name,code from parties where id=${link.party_id}::uuid`);if(!parties.rows[0])throw notFound();
      const receivables=await partyOpenItems(tx,link.party_id,{asOf:todayIso(),type:'receivable'});
      const payables=await partyOpenItems(tx,link.party_id,{asOf:todayIso(),type:'payable'});
      const sales=modules.has('construction.realestate')?(await tx.execute(sql`select code,status,currency_code as "currency",price,planned_handover as "plannedHandover" from sales_contracts where party_id=${link.party_id}::uuid order by contract_date desc limit 100`)).rows:[];
      const subcontracts=modules.has('construction.subcontracts')?(await tx.execute(sql`select code,title,status,currency_code as "currency" from subcontracts where party_id=${link.party_id}::uuid order by created_at desc limit 100`)).rows:[];
      const documents=link.document_ids.length?(await tx.execute(sql`select id,filename,size from record_documents where record_kind='party' and record_id=${link.party_id}::uuid and id=any(${`{${link.document_ids.join(',')}}`}::uuid[])`)).rows:[];
      return {company:company.name,party:parties.rows[0],receivables:receivables.receivable!.items.map(i=>({dueDate:i.dueDate,currency:i.currencyCode,remaining:i.remaining})),payables:payables.payable!.items.map(i=>({dueDate:i.dueDate,currency:i.currencyCode,remaining:i.remaining})),sales,subcontracts,documents,asOf:todayIso()};
    });
  });
};
