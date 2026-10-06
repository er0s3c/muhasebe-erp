import type { FastifyPluginAsync } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { idParam, resolveEnabledModules, todayIso, type Sector, type Role } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { setContext, withContext } from '../../db/client';
import { AppError, notFound, unauthorized } from '../../http/errors';
import { requireRecord } from './records';
import { loadMemberAccess } from '../access/effective';
import { partyOpenItems } from '../parties/service';
import { storeAsset, readAsset, validateAsset } from '../construction-control/storage';
import { randomUUID } from 'node:crypto';

const credentials = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12).max(128),
  documentId: z.uuid().optional(),
  action: z.enum(['request_service', 'confirm_service', 'passport_asset']).optional(),
  contractId: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  clientId: z.uuid().optional(),
  description: z.string().trim().min(3).max(4000).optional(),
  photo: z
    .object({
      filename: z
        .string()
        .min(1)
        .max(180)
        .refine((v) => !/[\\/]/.test(v)),
      mime: z.enum(['image/jpeg', 'image/png']),
      base64: z.string().max(7_000_000),
    })
    .optional(),
  passportId: z.uuid().optional(),
  assetId: z.uuid().optional(),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const portalRoutes: FastifyPluginAsync = async (app) => {
  const manage = { module: 'core.parties', permission: 'members.manage' } as const;
  app.get(
    '/api/workspace/portal-links',
    tenantRoute(app, manage, async (c) => ({
      items: (
        await c.tx.execute(
          sql`select l.id,l.label,l.party_id as "partyId",p.name as "partyName",l.expires_at as "expiresAt",l.revoked_at as "revokedAt" from portal_links l join parties p on p.id=l.party_id order by l.created_at desc limit 100`,
        )
      ).rows,
    })),
  );
  app.post(
    '/api/workspace/portal-links',
    tenantRoute(app, manage, async (c) => {
      const input = z
        .object({
          partyId: z.uuid(),
          label: z.string().trim().min(2).max(120),
          password: z.string().min(12).max(128),
          days: z.number().int().min(1).max(30),
          documentIds: z.array(z.uuid()).max(50).default([]),
        })
        .parse(c.req.body);
      await requireRecord(c, 'party', input.partyId);
      for (const id of input.documentIds) {
        const r = await c.tx.execute(
          sql`select id from record_documents where id=${id}::uuid and record_kind='party' and record_id=${input.partyId}::uuid`,
        );
        if (!r.rows.length) throw notFound('Paylaşılacak cari belgesi');
      }
      const token = randomBytes(32).toString('base64url');
      const id = uuidv7();
      const passwordHash = await hash(input.password);
      await c.tx
        .execute(sql`insert into portal_links(id,company_id,org_id,party_id,label,token_hash,password_hash,expires_at,created_by,document_ids)
      values(${id},${c.company.id},${c.user.orgId},${input.partyId},${input.label},${digest(token)},${passwordHash},now()+${input.days}*interval '1 day',${c.user.id},${`{${input.documentIds.join(',')}}`}::uuid[])`);
      await c.tx.execute(
        sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${c.company.id},${id},'created')`,
      );
      void c.reply.code(201);
      return { id, token };
    }),
  );
  app.post(
    '/api/workspace/portal-links/:id/revoke',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const result = await c.tx.execute(
        sql`update portal_links set revoked_at=now() where id=${id}::uuid returning id`,
      );
      if (!result.rows.length) throw notFound();
      await c.tx.execute(
        sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${c.company.id},${id},'revoked')`,
      );
      return { ok: true };
    }),
  );
  // External authentication is independent of staff sessions: secret + password, with expiry and revocation.
  app.post('/api/portal/view', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const budget = await app.limiter.consume(`portal:${req.ip}`, 20, 60_000);
    if (!budget.ok) {
      void reply.header('retry-after', String(budget.retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
    }
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) throw unauthorized('Portal erişimi doğrulanamadı.');
    const input = parsed.data;
    return withContext(app.db, {}, async (tx) => {
      await tx.execute(sql`select set_config('app.portal_hash',${digest(input.token)},true)`);
      const rows = await tx.execute<{
        id: string;
        company_id: string;
        org_id: string;
        party_id: string;
        created_by: string;
        password_hash: string;
        document_ids: string[];
      }>(
        sql`select id,company_id,org_id,party_id,created_by,password_hash,document_ids from portal_links where token_hash=${digest(input.token)} and revoked_at is null and expires_at>now()`,
      );
      const link = rows.rows[0];
      if (!link || !(await verify(link.password_hash, input.password)))
        throw unauthorized('Portal erişimi doğrulanamadı.');
      await setContext(tx, {
        companyId: link.company_id,
        orgId: link.org_id,
        userId: link.created_by,
        ip: req.ip,
      });
      const issuer = await tx.execute<{ role: Role }>(
        sql`select m.role from memberships m join users u on u.id=m.user_id where m.company_id=${link.company_id}::uuid and m.user_id=${link.created_by}::uuid and m.role in ('owner','admin') and u.is_active`,
      );
      if (!issuer.rows.length) throw unauthorized('Portal erişimi kapatılmış.');
      const issuerAccess = await loadMemberAccess(
        tx,
        link.company_id,
        link.created_by,
        issuer.rows[0]!.role,
      );
      if (
        !issuerAccess.permissions.has('members.manage') ||
        !issuerAccess.permissions.has('parties.read')
      )
        throw unauthorized('Portal erişimi kapatılmış.');
      const companies = await tx.execute<{ name: string; sector: Sector }>(
        sql`select name,sector from companies where id=${link.company_id}::uuid`,
      );
      const company = companies.rows[0];
      if (!company) throw unauthorized();
      const overrides = await tx.execute<{ module: string; enabled: boolean }>(
        sql`select module,enabled from company_modules`,
      );
      const modules = resolveEnabledModules(company.sector, overrides.rows);
      if (!modules.has('core.parties')) throw unauthorized('Portal erişimi kapatılmış.');
      const customerRead =
        modules.has('construction.realestate') && issuerAccess.permissions.has('realestate.read');
      const serviceEnabled =
        customerRead &&
        modules.has('construction.projects') &&
        issuerAccess.permissions.has('realestate.manage') &&
        issuerAccess.permissions.has('projects.manage');
      if (input.action) {
        if (!customerRead) throw unauthorized('Müşteri hizmetleri erişimi kapalı.');
        await tx.execute(
          sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${link.company_id},${link.id},${input.action})`,
        );
        if (input.action === 'passport_asset') {
          if (!input.passportId || !input.assetId) throw notFound();
          const passports = await tx.execute<{ payload: { devices: { documentIds: string[] }[] } }>(
            sql`select w.payload from construction_workflows w join sales_contracts s on s.id=(w.payload->>'contractId')::uuid where w.id=${input.passportId}::uuid and w.kind='passport' and w.status in ('approved','closed') and s.party_id=${link.party_id}::uuid and s.status in ('active','handed_over')`,
          );
          if (
            !passports.rows[0]?.payload.devices.some((d) => d.documentIds.includes(input.assetId!))
          )
            throw notFound();
          const assets = await tx.execute<{ mime: string; filename: string; sha256: string }>(
            sql`select mime,filename,sha256 from construction_assets where id=${input.assetId}::uuid`,
          );
          const a = assets.rows[0];
          if (!a) throw notFound();
          return reply
            .header('cache-control', 'no-store')
            .type(a.mime)
            .header(
              'content-disposition',
              `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
            )
            .send(await readAsset(app.config.CONSTRUCTION_STORAGE_DIR, link.company_id, a.sha256));
        }
        if (!serviceEnabled) throw unauthorized('Servis talebi erişimi kapalı.');
        if (input.action === 'confirm_service') {
          if (!input.serviceId) throw notFound();
          const services = await tx.execute<{
            id: string;
            data: { resolution?: string; coverage?: string };
          }>(
            sql`select w.id,(select e.data from construction_workflow_events e where e.workflow_id=w.id and e.action='service_updated' order by e.at desc limit 1) as data from construction_workflows w join sales_contracts s on s.id=(w.payload->>'contractId')::uuid where w.id=${input.serviceId}::uuid and w.kind='warranty' and w.status='approved' and s.party_id=${link.party_id}::uuid for update of w`,
          );
          const s = services.rows[0];
          if (!s?.data?.resolution) throw notFound('Çözüm bildirilmiş servis talebi');
          await tx.execute(
            sql`insert into construction_workflow_events(id,company_id,workflow_id,action,note,data,by) values(${uuidv7()},${link.company_id},${s.id},'customer_confirmed','Müşteri portalından çözüm teyidi',${JSON.stringify({ customerConfirmation: 'Portal müşteri teyidi', portalLinkId: link.id })}::jsonb,${link.created_by})`,
          );
          await tx.execute(
            sql`update construction_workflows set version=version+1 where id=${s.id}::uuid`,
          );
          return { confirmed: true };
        }
        if (!input.contractId || !input.clientId || !input.description)
          throw unauthorized('Servis talebi eksik.');
        const contracts = await tx.execute<{
          projectId: string;
          unitId: string;
          unitNo: string;
          block: string | null;
          floor: string | null;
        }>(
          sql`select s.project_id as "projectId",s.unit_id as "unitId",u.unit_no as "unitNo",u.block,u.floor from sales_contracts s join real_estate_units u on u.id=s.unit_id where s.id=${input.contractId}::uuid and s.party_id=${link.party_id}::uuid and s.status='handed_over' for update of s`,
        );
        const s = contracts.rows[0];
        if (!s) throw notFound('Teslim edilmiş satış sözleşmesi');
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${link.company_id + ':portal-unit:' + s.unitId},0))`,
        );
        const old = await tx.execute<{
          id: string;
          payload: { contractId: string; description: string };
        }>(
          sql`select id,payload from construction_workflows where id=${input.clientId}::uuid and kind='warranty'`,
        );
        if (old.rows[0]) {
          if (
            old.rows[0].payload.contractId !== input.contractId ||
            old.rows[0].payload.description !== input.description
          )
            throw unauthorized('Gönderim kimliği farklı talebe ait.');
          return { serviceId: old.rows[0].id };
        }
        let parentId: string | null = null,
          locationId = '';
        for (const [kind, name] of [
          ['building', s.block || 'Teslim edilen birimler'],
          ['level', s.floor || 'Kat bilgisi yok'],
          ['zone', s.unitNo],
        ]) {
          const existing = await tx.execute<{ id: string }>(
            sql`select id from construction_locations where project_id=${s.projectId}::uuid and kind=${kind} and name=${name} and parent_id is not distinct from ${parentId}::uuid limit 1`,
          );
          locationId = existing.rows[0]?.id ?? randomUUID();
          if (!existing.rows[0])
            await tx.execute(
              sql`insert into construction_locations(id,company_id,project_id,created_by,parent_id,kind,name) values(${locationId},${link.company_id},${s.projectId},${link.created_by},${parentId},${kind},${name})`,
            );
          parentId = locationId;
        }
        const photos: string[] = [];
        if (input.photo) {
          const bytes = Buffer.from(input.photo.base64, 'base64');
          if (bytes.length > 5 * 1024 * 1024) throw unauthorized('Servis fotoğrafı en fazla 5 MB.');
          validateAsset(bytes, input.photo.mime);
          const hash = await storeAsset(
              app.config.CONSTRUCTION_STORAGE_DIR,
              link.company_id,
              bytes,
            ),
            assetId = uuidv7(),
            photoId = uuidv7();
          await tx.execute(
            sql`insert into construction_assets(id,company_id,project_id,created_by,filename,mime,size,sha256) values(${assetId},${link.company_id},${s.projectId},${link.created_by},${input.photo.filename},${input.photo.mime},${bytes.length},${hash})`,
          );
          await tx.execute(
            sql`insert into construction_photos(id,company_id,project_id,created_by,location_id,asset_id,date,caption) values(${photoId},${link.company_id},${s.projectId},${link.created_by},${locationId},${assetId},${todayIso()},${input.description.slice(0, 500)})`,
          );
          photos.push(photoId);
        }
        const payload = {
          unitId: s.unitId,
          contractId: input.contractId,
          description: input.description,
          photoIds: photos,
          coverage: 'pending',
          customerConfirmation: '',
        };
        await tx.execute(
          sql`insert into construction_workflows(id,company_id,project_id,created_by,owner_id,location_id,kind,title,status,payload) values(${input.clientId},${link.company_id},${s.projectId},${link.created_by},${link.created_by},${locationId},'warranty',${input.description.slice(0, 200)},'submitted',${JSON.stringify(payload)}::jsonb)`,
        );
        await tx.execute(
          sql`insert into construction_workflow_events(id,company_id,workflow_id,action,note,data,by) values(${uuidv7()},${link.company_id},${input.clientId},'portal_created','Müşteri portalından servis talebi',${JSON.stringify({ portalLinkId: link.id })}::jsonb,${link.created_by})`,
        );
        return { serviceId: input.clientId };
      }
      await tx.execute(
        sql`insert into portal_access_events(id,company_id,link_id,action) values(${uuidv7()},${link.company_id},${link.id},${input.documentId ? 'download' : 'view'})`,
      );
      if (input.documentId) {
        if (!link.document_ids.includes(input.documentId)) throw notFound();
        const docs = await tx.execute<{ filename: string; mime: string; content: string }>(
          sql`select d.filename,d.mime,b.content from record_documents d join record_document_content b on b.id=d.id where d.id=${input.documentId}::uuid and d.record_kind='party' and d.record_id=${link.party_id}::uuid`,
        );
        const doc = docs.rows[0];
        if (!doc) throw notFound();
        return reply
          .header('content-type', doc.mime)
          .header(
            'content-disposition',
            `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
          )
          .header('cache-control', 'no-store')
          .send(Buffer.from(doc.content, 'base64'));
      }
      const parties = await tx.execute<{ name: string; code: string }>(
        sql`select name,code from parties where id=${link.party_id}::uuid`,
      );
      if (!parties.rows[0]) throw notFound();
      const receivables = await partyOpenItems(tx, link.party_id, {
        asOf: todayIso(),
        type: 'receivable',
      });
      const payables = await partyOpenItems(tx, link.party_id, {
        asOf: todayIso(),
        type: 'payable',
      });
      const sales =
        modules.has('construction.realestate') && issuerAccess.permissions.has('realestate.read')
          ? (
              await tx.execute(
                sql`select id,unit_id as "unitId",code,status,currency_code as "currency",price,planned_handover as "plannedHandover" from sales_contracts where party_id=${link.party_id}::uuid order by contract_date desc limit 100`,
              )
            ).rows
          : [];
      const subcontracts =
        modules.has('construction.subcontracts') &&
        issuerAccess.permissions.has('subcontracts.read')
          ? (
              await tx.execute(
                sql`select code,title,status,currency_code as "currency" from subcontracts where party_id=${link.party_id}::uuid order by created_at desc limit 100`,
              )
            ).rows
          : [];
      const documents = link.document_ids.length
        ? (
            await tx.execute(
              sql`select id,filename,size from record_documents where record_kind='party' and record_id=${link.party_id}::uuid and id=any(${`{${link.document_ids.join(',')}}`}::uuid[])`,
            )
          ).rows
        : [];
      return {
        serviceEnabled,
        services: customerRead
          ? (
              await tx.execute(
                sql`select w.id,w.title,w.status,w.payload->>'description' as description,(select e.data->>'resolution' from construction_workflow_events e where e.workflow_id=w.id and e.action='service_updated' order by e.at desc limit 1) as resolution,exists(select 1 from construction_workflow_events e where e.workflow_id=w.id and e.action='customer_confirmed' and e.at>=(select max(x.at) from construction_workflow_events x where x.workflow_id=w.id and x.action='service_updated')) as confirmed from construction_workflows w join sales_contracts s on s.id=(w.payload->>'contractId')::uuid where w.kind='warranty' and s.party_id=${link.party_id}::uuid order by w.created_at desc limit 100`,
              )
            ).rows
          : [],
        passports: customerRead
          ? (
              await tx.execute(
                sql`select w.id,w.title,w.payload from construction_workflows w join sales_contracts s on s.id=(w.payload->>'contractId')::uuid where w.kind='passport' and w.status in ('approved','closed') and s.party_id=${link.party_id}::uuid and s.status in ('active','handed_over') order by w.created_at desc limit 100`,
              )
            ).rows
          : [],
        company: company.name,
        party: parties.rows[0],
        receivables: receivables.receivable!.items.map((i) => ({
          dueDate: i.dueDate,
          currency: i.currencyCode,
          remaining: i.remaining,
        })),
        payables: payables.payable!.items.map((i) => ({
          dueDate: i.dueDate,
          currency: i.currencyCode,
          remaining: i.remaining,
        })),
        sales,
        subcontracts,
        documents,
        asOf: todayIso(),
      };
    });
  });
};
