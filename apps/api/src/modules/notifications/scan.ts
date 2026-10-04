import { sql } from 'drizzle-orm';
import {
  eligibleNotificationKinds,
  notificationFingerprint,
  notificationKindDef,
  nowLocal,
  resolveEnabledModules,
  resolveLeadDays,
  type NotificationKind,
  type Role,
  type Sector,
} from '@erp/shared';
import { setContext, withContext, type Db, type Tx } from '../../db/client';
import type { MailMessage } from '../mail/mailer';
import { notificationDigestMail } from '../mail/templates';
import { NOTIFICATION_SOURCES, type Finding, type LicenseView, type ScanCtx } from './sources';

/** Advisory kilit ad alanı ("NOTI"): şirket başına ikinci anahtar `hashtext(company_id)`. Aynı şirketi iki örnek aynı anda taramaz. */
const LOCK_NAMESPACE = 0x4e4f5449;

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface ScanOptions {
  /** Şimdiki an (testler enjekte eder); gün sınırı Europe/Nicosia'dır. */
  now?: Date;
  /**
   * true: kilit başka bir örnekte tutuluyorsa BEKLER (elle tarama). false: tarama o şirket için ATLANIR (zamanlayıcı; diğer örnek
   * zaten tarıyor). Varsayılan false.
   */
  wait?: boolean;
  /** Kurulumun lisans durumu (kurulum düzeyinde; şirket bağlamı değildir). Verilmezse lisans bildirimi üretilmez. */
  license?: () => Promise<LicenseView | null>;
  /** E-posta özeti gönderimi: yalnızca verilirse (SMTP/günlük kipi açıksa) özet üretilir. Gönderim işlem tamamlandıktan sonradır. */
  enqueueMail?: (message: MailMessage) => void;
  /** E-postadaki bağlantıların kökü (APP_BASE_URL). */
  baseUrl?: string;
  /** Kapanmış bildirim saklama süresi (gün). */
  retentionDays?: number;
  /** E-posta özetinin gönderileceği ilk yerel saat (0–23): bundan önceki taramalar özet göndermez. */
  digestHour?: number;
  log?: Logger;
}

export interface CompanyScanResult {
  companyId: string;
  /** Kilit başka örnekte olduğu için atlandı. */
  skipped: boolean;
  users: number;
  created: number;
  resolved: number;
  pruned: number;
  digests: number;
  /** Kaynak hatası nedeniyle bu taramada değerlendirilemeyen türler (açık bildirimleri çözülmeden bırakılır). */
  failedKinds: NotificationKind[];
}

interface Member {
  userId: string;
  role: Role;
  email: string;
  fullName: string;
}

type PrefRow = { kind: NotificationKind; inApp: boolean; email: boolean; leadDays: number | null };

const emptyResult = (companyId: string, skipped = false): CompanyScanResult => ({ companyId, skipped, users: 0, created: 0, resolved: 0, pruned: 0, digests: 0, failedKinds: [] });

/**
 * Bir şirketin bildirimlerini üretir/günceller (tek işlem). Her üyeye o üyenin kendi RLS bağlamında (app.user_id) yazılır; şirketler
 * arası RLS aşımı yoktur. Aynı durum için kopya üretmez, koşul kalkınca açık bildirimi çözer, saklama süresi dolanları budar ve
 * (SMTP açıksa, kullanıcı istediyse) günde en çok bir e-posta özeti üretir. Şirket başına advisory kilidi vardır.
 */
export async function scanCompany(db: Db, target: { companyId: string; orgId: string }, opts: ScanOptions = {}): Promise<CompanyScanResult> {
  const mails: MailMessage[] = [];
  const now = opts.now ?? new Date();
  const local = nowLocal(now);
  const license = opts.license ? await opts.license().catch(() => null) : null;

  const result = await withContext(db, { orgId: target.orgId, companyId: target.companyId }, async (tx) => {
    const lockKey = sql`${LOCK_NAMESPACE}::int, hashtext(${target.companyId}::text)`;
    if (opts.wait) {
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    } else {
      const got = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${lockKey}) as ok`);
      if (!got.rows[0]?.ok) return emptyResult(target.companyId, true);
    }

    const [company] = (await tx.execute<{ sector: string }>(sql`select sector from companies where id = ${target.companyId}::uuid`)).rows;
    if (!company) return emptyResult(target.companyId);
    const overrides = (await tx.execute<{ module: string; enabled: boolean }>(sql`select module, enabled from company_modules`)).rows;
    const enabled = resolveEnabledModules(company.sector as Sector, overrides);
    const dbOwner = (await tx.execute<{ id: string | null }>(sql`select installation_owner_org() as id`)).rows[0]?.id ?? null;
    const owner = license && license.ownerOrgId !== undefined ? license.ownerOrgId : dbOwner;
    const ctx: ScanCtx = { tx, companyId: target.companyId, today: local.date, time: local.time, enabled, license, ownerOrg: owner === target.orgId };

    const members = (
      await tx.execute<{ userId: string; role: Role; email: string; fullName: string }>(sql`
        select m.user_id as "userId", m.role, u.email, u.full_name as "fullName"
          from memberships m join users u on u.id = m.user_id
         where m.company_id = ${target.companyId}::uuid and u.is_active
         order by m.created_at, m.user_id`)
    ).rows;

    const res = emptyResult(target.companyId);
    const failed = new Set<NotificationKind>();
    // Aynı (tür, gün eşiği[, kullanıcı]) için kaynak bir kez çalışır
    const cache = new Map<string, Finding | null | 'failed'>();
    const sourceLeads = new Map<NotificationKind, number | null>();

    const runSource = async (kind: NotificationKind, lead: number | null, member: Member): Promise<Finding | null | 'failed'> => {
      const src = NOTIFICATION_SOURCES[kind];
      const key = `${kind}|${lead ?? ''}|${src.perUser ? member.userId : ''}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let out: Finding | null | 'failed';
      try {
        // Kaynak hatası işlemi bozmasın: kaydedilen nokta (savepoint) geri alınır
        out = await tx.transaction((sp) => src.scan({ ...ctx, tx: sp as Tx }, { lead, user: { id: member.userId, role: member.role } }));
      } catch (err) {
        opts.log?.warn({ err: err instanceof Error ? err.message : String(err), kind, companyId: target.companyId }, 'bildirim kaynağı taranamadı');
        out = 'failed';
      }
      cache.set(key, out);
      return out;
    };

    for (const member of members) {
      await setContext(tx, { userId: member.userId, orgId: target.orgId, companyId: target.companyId });
      res.users++;
      const prefs = new Map(
        (
          await tx.execute<PrefRow>(sql`select kind, in_app as "inApp", email, lead_days as "leadDays" from notification_preferences`)
        ).rows.map((p) => [p.kind, p]),
      );
      const eligible = eligibleNotificationKinds(member.role, enabled);

      const desired = new Map<NotificationKind, { key: string; finding: Finding }>();
      const userFailed = new Set<NotificationKind>();
      for (const kind of eligible) {
        const pref = prefs.get(kind);
        if (pref && !pref.inApp) continue; // uygulama içi kapalı: üretilmez, açık olanlar aşağıda çözülür
        const def = notificationKindDef(kind);
        const src = NOTIFICATION_SOURCES[kind];
        if (!sourceLeads.has(kind)) {
          const sl = await (src.sourceLead ? tx.transaction((sp) => src.sourceLead!({ ...ctx, tx: sp as Tx })) : Promise.resolve(null)).catch(() => null);
          sourceLeads.set(kind, sl);
        }
        const lead = resolveLeadDays(def, pref?.leadDays ?? null, sourceLeads.get(kind) ?? null);
        const finding = await runSource(kind, lead, member);
        if (finding === 'failed') {
          userFailed.add(kind);
          failed.add(kind);
        } else if (finding && finding.count >= 0) {
          desired.set(kind, { key: notificationFingerprint([kind, ...finding.parts]), finding });
        }
      }

      // --- Uzlaştır: yeni durumları ekle, artık geçerli olmayan açıkları çöz ---------------------------------------------
      const open = (
        await tx.execute<{ id: string; kind: NotificationKind; dedupeKey: string }>(sql`
          select id, kind, dedupe_key as "dedupeKey" from notifications where resolved_at is null`)
      ).rows;
      const openKeys = new Set(open.map((o) => `${o.kind}|${o.dedupeKey}`));
      for (const [kind, d] of desired) {
        if (openKeys.has(`${kind}|${d.key}`)) continue;
        const f = d.finding;
        const ins = await tx.execute<{ inserted: boolean }>(sql`
          insert into notifications (id, company_id, user_id, kind, severity, title, body, link, count, dedupe_key, bucket_date)
          values (gen_random_uuid(), ${target.companyId}::uuid, ${member.userId}::uuid, ${kind}, ${f.severity}, ${f.title}, ${f.body},
                  ${f.link ?? notificationKindDef(kind).link}, ${f.count}, ${d.key}, ${local.date}::date)
          on conflict (company_id, user_id, kind, dedupe_key, bucket_date)
          do update set resolved_at = null where notifications.resolved_at is not null
          returning (xmax = 0) as inserted`);
        if (ins.rows[0]?.inserted) res.created++;
      }
      for (const o of open) {
        if (userFailed.has(o.kind)) continue; // taranamadı: durum bilinmiyor, çözme
        const want = desired.get(o.kind);
        if (want && want.key === o.dedupeKey) continue;
        await tx.execute(sql`update notifications set resolved_at = now() where id = ${o.id}::uuid and resolved_at is null`);
        res.resolved++;
      }

      // --- E-posta özeti (isteğe bağlı, günde en çok bir) ---------------------------------------------------------------
      if (opts.enqueueMail && Number(local.time.slice(0, 2)) >= (opts.digestHour ?? 8)) {
        const emailKinds = eligible.filter((k) => prefs.get(k)?.email);
        if (emailKinds.length > 0) {
          const rows = (
            await tx.execute<{ title: string }>(sql`
              select title from notifications
               where resolved_at is null and dismissed_at is null and read_at is null and kind in (${sql.join(emailKinds.map((k) => sql`${k}`), sql`, `)})
               order by created_at, id`)
          ).rows;
          if (rows.length > 0) {
            const claim = await tx.execute(sql`
              insert into notification_digests (company_id, user_id, digest_date, item_count)
              values (${target.companyId}::uuid, ${member.userId}::uuid, ${local.date}::date, ${rows.length})
              on conflict do nothing returning 1`);
            if (claim.rows.length > 0) {
              const companyName = (await tx.execute<{ name: string }>(sql`select name from companies where id = ${target.companyId}::uuid`)).rows[0]?.name ?? '';
              mails.push(notificationDigestMail(member.email, member.fullName, companyName, rows.map((r) => r.title), `${opts.baseUrl ?? ''}/notifications`));
              res.digests++;
            }
          }
        }
      }
    }
    res.failedKinds = [...failed];

    // Saklama: kapanmış bildirimler ve eski özet kayıtları (şirket bağlamında; kullanıcı bağlamı gerekmez)
    await setContext(tx, { orgId: target.orgId, companyId: target.companyId });
    const pruned = await tx.execute<{ n: number }>(sql`select notification_prune(${opts.retentionDays ?? 90}) as n`);
    res.pruned = pruned.rows[0]?.n ?? 0;
    return res;
  });

  // Gönderim işlem tamamlandıktan sonradır (geri alınan bir özet gönderilmez)
  if (opts.enqueueMail) {
    for (const m of mails) {
      try {
        opts.enqueueMail(m);
      } catch (err) {
        opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'bildirim özeti gönderime verilemedi');
      }
    }
  }
  return result;
}

export interface ScanAllResult {
  companies: number;
  skipped: number;
  created: number;
  resolved: number;
  pruned: number;
  digests: number;
  errors: number;
}

/** Tüm şirketleri tek tek (sırayla, her biri kendi işleminde ve kendi RLS bağlamında) tarar. Bir şirketin hatası diğerlerini durdurmaz. */
export async function scanAll(db: Db, opts: ScanOptions = {}): Promise<ScanAllResult> {
  const targets = (await db.execute<{ company_id: string; organization_id: string }>(sql`select company_id, organization_id from notification_scan_targets()`)).rows;
  const out: ScanAllResult = { companies: 0, skipped: 0, created: 0, resolved: 0, pruned: 0, digests: 0, errors: 0 };
  for (const t of targets) {
    try {
      const r = await scanCompany(db, { companyId: t.company_id, orgId: t.organization_id }, opts);
      out.companies++;
      if (r.skipped) out.skipped++;
      out.created += r.created;
      out.resolved += r.resolved;
      out.pruned += r.pruned;
      out.digests += r.digests;
    } catch (err) {
      out.errors++;
      opts.log?.warn({ err: err instanceof Error ? err.message : String(err), companyId: t.company_id }, 'bildirim taraması başarısız');
    }
  }
  return out;
}

