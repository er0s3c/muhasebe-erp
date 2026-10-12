import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { operationsSettingsSchema, idParam } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden } from '../../http/errors';
import { operationalSettings } from './settings';
import { activityReport, requireAdministrator } from './report';
import { getTask } from '../workspace/routes';
import {
  companyFxProvider,
  requireCompanyFxProvider,
  FX_PROVIDER_REGISTRY,
} from '../settings/fx-providers';
import { importPublishedRates } from '../settings/fx-import';
import { requireBackupOwner } from './backups';

export async function runRateImport(
  app: FastifyInstance,
  c: Pick<TenantCtx, 'tx' | 'user' | 'company' | 'require'>,
) {
  c.require('rates.manage');
  const id = uuidv7();
  await c.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':auto-rates'},0))`,
  );
  await c.tx.execute(
    sql`insert into administration_runs(id,company_id,kind,status,requested_by) values(${id},${c.company.id},'rates','running',${c.user.id})`,
  );
  try {
    const provider = requireCompanyFxProvider(c.company);
    const definition = FX_PROVIDER_REGISTRY[provider];
    const day = definition.parse(await app.fxRateFetcher(provider));
    const result = await importPublishedRates(
      c.tx,
      { companyId: c.company.id, userId: c.user.id },
      day,
      { provider, sourceUrl: definition.url(day.date) },
    );
    await c.tx.execute(
      sql`update administration_runs set status='succeeded',finished_at=now(),result=${JSON.stringify(result)}::jsonb where id=${id}::uuid`,
    );
    return { id, status: 'succeeded', result };
  } catch (error) {
    // The failed attempt is persisted; an unavailable feed must never become a zero rate.
    if ((error as { code?: string }).code?.match(/^\d/)) throw error;
    const message =
      error instanceof Error ? error.message.slice(0, 1000) : 'Kur indirme başarısız.';
    await c.tx.execute(
      sql`update administration_runs set status='failed',finished_at=now(),error=${message} where id=${id}::uuid`,
    );
    return { id, status: 'failed', error: message };
  }
}

export const administrationRoutes: FastifyPluginAsync = async (app) => {
  const settingsAccess = { module: 'core.settings', permission: 'settings.read' } as const;
  const workspace = { module: 'core.dashboard', permission: 'workspace.use' } as const;
  app.get(
    '/api/workspace/upload-limits',
    tenantRoute(app, workspace, async (c) => {
      const { settings } = await operationalSettings(c.tx);
      return { documentLimitMb: settings.documentLimitMb, fieldLimitMb: settings.fieldLimitMb };
    }),
  );
  app.get(
    '/api/settings/document-format',
    tenantRoute(app, { module: 'core.invoices', permission: 'invoices.read' }, async (c) => {
      const { settings } = await operationalSettings(c.tx);
      return { invoicePrintTemplate: settings.invoicePrintTemplate };
    }),
  );
  app.get(
    '/api/settings/operations',
    tenantRoute(app, settingsAccess, async (c) => {
      requireAdministrator(c);
      const data = await operationalSettings(c.tx);
      const runs = (
        await c.tx.execute(
          sql`select id,kind,status,started_at as "startedAt",finished_at as "finishedAt",result,error from administration_runs order by started_at desc limit 30`,
        )
      ).rows;
      const provider = companyFxProvider(c.company);
      return {
        ...data,
        runs,
        rateProvider: provider,
        rateProviderLabel: provider ? FX_PROVIDER_REGISTRY[provider].label : null,
        rateSource: provider ? FX_PROVIDER_REGISTRY[provider].url() : null,
        timeZone: c.company.timeZone,
        jurisdiction: c.company.jurisdiction,
      };
    }),
  );
  app.put(
    '/api/settings/operations',
    tenantRoute(app, { module: 'core.settings', permission: 'settings.manage' }, async (c) => {
      requireAdministrator(c);
      const { settings, version } = z
        .object({ settings: operationsSettingsSchema, version: z.number().int().min(0) })
        .parse(c.req.body);
      if (settings.requireMfa) {
        const mfa = (
          await c.tx.execute(
            sql`select 1 from user_mfa where user_id=${c.user.id}::uuid and enabled_at is not null`,
          )
        ).rows;
        if (!mfa.length)
          throw badRequest(
            'Şirkette MFA zorunluluğunu açmadan önce kendi hesabınızda iki adımlı doğrulamayı etkinleştirin.',
          );
      }
      if (settings.automaticRates) {
        c.require('rates.manage');
        requireCompanyFxProvider(c.company);
      }
      if (settings.automaticBackup) await requireBackupOwner(app, c);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':operations-settings'},0))`,
      );
      const current = await operationalSettings(c.tx);
      if (current.version !== version)
        throw conflict('Ayarlar başka biri tarafından değiştirildi; yenileyin.');
      await c.tx
        .execute(sql`insert into company_operations_settings(company_id,settings,updated_by,version) values(${c.company.id},${JSON.stringify(settings)}::jsonb,${c.user.id},1)
      on conflict(company_id) do update set settings=excluded.settings,updated_by=excluded.updated_by,updated_at=now(),version=company_operations_settings.version+1`);
      return operationalSettings(c.tx);
    }),
  );
  app.post(
    '/api/settings/operations/rates/run',
    tenantRoute(
      app,
      {
        module: 'core.settings',
        permission: 'rates.manage',
        limit: { name: 'auto-rates', max: 5, windowMs: 60000 },
      },
      async (c) => {
        requireAdministrator(c);
        return runRateImport(app, c);
      },
    ),
  );
  app.get(
    '/api/reports/activity',
    tenantRoute(app, { module: 'core.settings', permission: 'members.manage' }, activityReport),
  );
  app.get(
    '/api/workspace/time',
    tenantRoute(app, workspace, async (c) => {
      const rows = (
        await c.tx
          .execute(sql`select s.id,s.task_id as "taskId",w.title,s.user_id as "userId",u.full_name as "userName",s.started_at as "startedAt",s.stopped_at as "stoppedAt",extract(epoch from (coalesce(s.stopped_at,least(now(),s.started_at+interval '24 hours'))-s.started_at))::int as seconds,s.note
      from work_time_sessions s join work_items w on w.id=s.task_id join users u on u.id=s.user_id where s.user_id=${c.user.id}::uuid order by s.started_at desc limit 30`)
      ).rows;
      const visible = [];
      for (const row of rows) {
        try {
          await getTask(c, row.taskId as string);
          visible.push(row);
        } catch (error) {
          if (
            (error as { status?: number }).status === 403 ||
            (error as { status?: number }).status === 404
          )
            continue;
          throw error;
        }
      }
      return { items: visible };
    }),
  );
  app.post(
    '/api/workspace/tasks/:id/time/start',
    tenantRoute(app, workspace, async (c) => {
      const { id } = idParam.parse(c.req.params),
        task = await getTask(c, id);
      if (task.status !== 'open') throw badRequest('Yalnızca açık görevlerde süre başlatılabilir.');
      if (task.ownerId !== c.user.id && !c.can('members.manage'))
        throw forbidden('Bu görev size atanmamış.');
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + c.user.id + ':timer'},0))`,
      );
      await c.tx.execute(
        sql`update work_time_sessions set stopped_at=started_at+interval '24 hours',note=note || ' · 24 saat sınırında otomatik kapatıldı' where user_id=${c.user.id}::uuid and stopped_at is null and started_at<now()-interval '24 hours'`,
      );
      const active = (
        await c.tx.execute(
          sql`select id from work_time_sessions where user_id=${c.user.id}::uuid and stopped_at is null`,
        )
      ).rows;
      if (active.length) throw conflict('Çalışan bir sayacınız var; önce onu durdurun.');
      const sessionId = uuidv7();
      await c.tx.execute(
        sql`insert into work_time_sessions(id,company_id,task_id,user_id) values(${sessionId},${c.company.id},${id},${c.user.id})`,
      );
      return { id: sessionId };
    }),
  );
  app.post(
    '/api/workspace/time/:id/stop',
    tenantRoute(app, workspace, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const { note } = z
        .object({ note: z.string().trim().max(1000).default('') })
        .parse(c.req.body ?? {});
      const row = (
        await c.tx.execute<{ task_id: string }>(
          sql`select task_id from work_time_sessions where id=${id}::uuid and user_id=${c.user.id}::uuid`,
        )
      ).rows[0];
      if (!row) throw forbidden('Bu sayaç size ait değil.');
      await getTask(c, row.task_id);
      await c.tx.execute(
        sql`update work_time_sessions set stopped_at=least(now(),started_at+interval '24 hours'),note=${note} where id=${id}::uuid and user_id=${c.user.id}::uuid and stopped_at is null`,
      );
      return { ok: true };
    }),
  );
};
