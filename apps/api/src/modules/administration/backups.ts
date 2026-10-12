import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { idParam, operationsSettingsSchema } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { withContext } from '../../db/client';
import { badRequest, forbidden, conflict, AppError } from '../../http/errors';
import { loadMemberAccess } from '../access/effective';
import { operationalSettings } from './settings';

const MAX_PACKAGE=128*1024*1024;
const filenames=['database.dump','files.gz','files.gz.sha256','manifest.json'] as const;
const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
type BackupContext=Pick<TenantCtx,'tx'|'company'|'user'|'require'>;
type Run={id:string;kind:string;status:string;requestedBy:string;result:Record<string,unknown>};
function folder(app:FastifyInstance,id:string) {
  if(!z.uuid().safeParse(id).success) throw badRequest('Geçersiz yedek kimliği.');
  return join(resolve(app.config.BACKUP_DIRECTORY),id);
}
function connection(app:FastifyInstance) {
  if(!app.config.BACKUP_DATABASE_URL) throw badRequest('Kurulum yedekleme bağlantısı yapılandırılmamış. BACKUP_DATABASE_URL gerekir.','BACKUP_NOT_CONFIGURED');
  const url=new URL(app.config.BACKUP_DATABASE_URL),runtime=new URL(app.config.DATABASE_URL);
  if(url.hostname!==runtime.hostname || url.port!==runtime.port || url.pathname!==runtime.pathname) throw badRequest('Yedekleme bağlantısı çalışma veritabanını göstermeli.');
  return url;
}
async function ownerCheck(app:FastifyInstance,orgId:string) {
  const url=connection(app);
  const pool=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000});
  try {
    const organizations=await pool.query('select id from organizations order by created_at');
    if(organizations.rows.length!==1 || organizations.rows[0]?.id!==orgId)
      throw forbidden('Tam kurulum yedeği yalnızca tek kuruluşa ait özel kurulumda kullanılabilir. Paylaşılan kurulumda şirket veri dışa aktarımını kullanın.','BACKUP_INSTALLATION_SCOPE');
    const roles=await pool.query("select rolname,rolcreatedb from pg_roles where rolname=current_user");
    return {poolRole:roles.rows[0]?.rolname as string,canRestore:!!roles.rows[0]?.rolcreatedb};
  } finally {await pool.end();}
}
export async function requireBackupOwner(app:FastifyInstance,c:BackupContext) {
  c.require('company.manage');
  return ownerCheck(app,c.user.orgId);
}
function pgEnvironment(url:URL) {
  const out:NodeJS.ProcessEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)};
  const ssl=url.searchParams.get('sslmode'); if(ssl) out.PGSSLMODE=ssl;
  return out;
}
async function pgTool(app:FastifyInstance,name:'pg_dump'|'pg_restore',args:string[],output?:string) {
  const url=connection(app);
  const docker=app.config.BACKUP_DOCKER_CONTAINER;
  if(docker && app.config.NODE_ENV==='production') throw badRequest('Üretimde Docker soketi yerine PostgreSQL istemci araçlarını kullanın.');
  const cmd=docker ? 'docker' : app.config.BACKUP_PG_BIN ? join(app.config.BACKUP_PG_BIN,name+(process.platform==='win32'?'.exe':'')) : name;
  const actual=docker ? ['exec','-i',docker,name,'-U',decodeURIComponent(url.username),...args] : args;
  const child=spawn(cmd,actual,{env:pgEnvironment(url),stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stdin.end();
  let errorOutput=''; child.stderr.on('data',(v:Buffer)=>{if(errorOutput.length<4000)errorOutput+=v.toString();});
  let outputDone:Promise<void>;
  if(output) outputDone=pipeline(child.stdout,createWriteStream(output,{flags:'wx',mode:0o600}));
  else {child.stdout.resume(); outputDone=Promise.resolve();}
  const timeout=setTimeout(()=>child.kill(),300000); timeout.unref();
  try {
    await Promise.all([outputDone,new Promise<void>((ok,fail)=>{child.on('error',fail);child.on('close',code=>code===0?ok():fail(new Error(`PostgreSQL ${name} tamamlanamadı: ${errorOutput.slice(0,1500) || 'çıkış '+code}`)));})]);
  } finally {clearTimeout(timeout);}
}
async function filesTool() {
  const local=fileURLToPath(new URL('./construction-files.mjs',import.meta.url));
  const path=existsSync(local)?local:fileURLToPath(new URL('../../../../../installer/tools/construction-files.mjs',import.meta.url));
  return await import(pathToFileURL(path).href) as {backupFiles:(root:string,archive:string)=>Promise<{count:number}>;restoreFiles:(root:string,archive:string)=>Promise<{count:number}>};
}
async function shaFile(path:string) {const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
function signature(app:FastifyInstance,body:string) {return createHmac('sha256',app.config.BACKUP_SIGNING_KEY??app.config.JWT_SECRET).update('erp-installation-backup-v1\n'+body).digest('hex');}
function verifyManifest(app:FastifyInstance,bytes:Uint8Array) {
  const signed=z.object({body:z.string().max(10000),signature:z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(Buffer.from(bytes).toString()));
  if(!timingSafeEqual(Buffer.from(signed.signature,'hex'),Buffer.from(signature(app,signed.body),'hex'))) throw badRequest('Yedeğin kurulum imzası doğrulanamadı. Eski kurulumun BACKUP_SIGNING_KEY anahtarı gerekir.','BACKUP_SIGNATURE_INVALID');
  return z.object({format:z.literal('erp-installation-backup-v1'),organizationId:z.uuid(),createdAt:z.string(),version:z.string(),databaseSha256:z.string().regex(/^[a-f0-9]{64}$/),filesSha256:z.string().regex(/^[a-f0-9]{64}$/),fileCount:z.number().int().nonnegative()}).parse(JSON.parse(signed.body));
}
async function packageBytes(app:FastifyInstance,id:string) {
  const root=folder(app,id);
  const sizes=await Promise.all(filenames.map(f=>stat(join(root,f))));
  if(sizes.reduce((n,s)=>n+s.size,0)>MAX_PACKAGE) throw badRequest('Yedek web indirme sınırını (128 MB) aşıyor. Sunucudaki dosyaları işletim betikleriyle aktarın.','BACKUP_PACKAGE_TOO_LARGE');
  const entries:Record<string,Uint8Array>={};
  for(const f of filenames) entries[f]=await readFile(join(root,f));
  return Buffer.from(zipSync(entries,{level:0}));
}
export async function inspectBackupPackage(app:FastifyInstance,c:BackupContext,bytes:Buffer) {
  if(bytes.length>MAX_PACKAGE || bytes.length<50) throw badRequest('Yedek paketi 128 MB sınırını aşıyor veya boş.');
  let expanded=0; const names=new Set<string>();
  let entries:Record<string,Uint8Array>;
  try { entries=unzipSync(bytes,{filter:f=>{
    if(!filenames.includes(f.name as typeof filenames[number]) || names.has(f.name)) throw new Error('Beklenmeyen arşiv dosyası.');
    names.add(f.name); expanded+=f.originalSize;
    if(!Number.isSafeInteger(f.originalSize) || expanded>MAX_PACKAGE) throw new Error('Açılan yedek boyutu sınırı aşılıyor.');
    return true;
  }}); } catch {throw badRequest('Yedek arşivi bozuk, yinelenen dosya içeriyor veya boyutu sınırı aşıyor.');}
  if(filenames.some(f=>!entries[f])) throw badRequest('Yedek paketinde gerekli dosyalar eksik.');
  const manifest=verifyManifest(app,entries['manifest.json']!);
  if(manifest.organizationId!==c.user.orgId) throw forbidden('Bu yedek kuruluşunuza ait değil.');
  if(hash(entries['database.dump']!)!==manifest.databaseSha256 || hash(entries['files.gz']!)!==manifest.filesSha256 || Buffer.from(entries['files.gz.sha256']!).toString().trim()!==manifest.filesSha256) throw badRequest('Yedek dosyalarının SHA-256 özeti uyuşmuyor.','BACKUP_HASH_MISMATCH');
  if(Buffer.from(entries['database.dump']!).subarray(0,5).toString()!=='PGDMP') throw badRequest('Geçersiz PostgreSQL yedeği.');
  const id=uuidv7(),root=folder(app,id);await mkdir(root,{recursive:true,mode:0o700});
  for(const f of filenames) await writeFile(join(root,f),entries[f]!,{flag:'wx',mode:0o600});
  await c.tx.execute(sql`insert into administration_runs(id,company_id,kind,status,requested_by,result) values(${id},${c.company.id},'restore','staged',${c.user.id},${JSON.stringify({manifest,stage:'preflight'})}::jsonb)`);
  return {id,manifest};
}
async function makeBackup(app:FastifyInstance,orgId:string,id:string) {
  await ownerCheck(app,orgId);
  const root=folder(app,id);await mkdir(root,{recursive:true,mode:0o700});
  const url=connection(app);
  await pgTool(app,'pg_dump',['-Fc','--no-password',decodeURIComponent(url.pathname.slice(1))],join(root,'database.dump'));
  const tool=await filesTool(),files=await tool.backupFiles(app.config.CONSTRUCTION_STORAGE_DIR,join(root,'files.gz'));
  const manifest={format:'erp-installation-backup-v1',organizationId:orgId,createdAt:new Date().toISOString(),version:app.config.APP_VERSION,databaseSha256:await shaFile(join(root,'database.dump')),filesSha256:await shaFile(join(root,'files.gz')),fileCount:files.count};
  const body=JSON.stringify(manifest);
  await writeFile(join(root,'manifest.json'),JSON.stringify({body,signature:signature(app,body)}),{flag:'wx',mode:0o600});
  return {manifest,size:(await stat(join(root,'database.dump'))).size+(await stat(join(root,'files.gz'))).size};
}
async function restoreIsolated(app:FastifyInstance,orgId:string,id:string) {
  const rights=await ownerCheck(app,orgId);
  if(!rights.canRestore) throw badRequest('Ayrı kurtarma veritabanı için yedekleme rolünde CREATEDB yetkisi gerekir.');
  const root=folder(app,id),manifest=verifyManifest(app,await readFile(join(root,'manifest.json')));
  if(manifest.organizationId!==orgId || await shaFile(join(root,'database.dump'))!==manifest.databaseSha256 || await shaFile(join(root,'files.gz'))!==manifest.filesSha256) throw badRequest('Geri yükleme öncesi bütünlük doğrulaması başarısız.');
  const dbName='erp_recovery_'+id.replaceAll('-','');
  const url=connection(app),pool=new pg.Pool({connectionString:url.toString(),max:1});
  try {await pool.query(`create database "${dbName}" template template0`);}finally{await pool.end();}
  // For Docker development the dump is streamed in; production uses a private local file.
  if(app.config.BACKUP_DOCKER_CONTAINER) {
    const child=spawn('docker',['exec','-i',app.config.BACKUP_DOCKER_CONTAINER,'pg_restore','-U',decodeURIComponent(url.username),'--exit-on-error','--single-transaction','-d',dbName],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let message='';child.stderr.on('data',(b:Buffer)=>{if(message.length<1500)message+=b.toString();});
    const timeout=setTimeout(()=>child.kill(),300000);timeout.unref();
    try {await Promise.all([pipeline(createReadStream(join(root,'database.dump')),child.stdin),new Promise<void>((ok,fail)=>{child.on('error',fail);child.on('close',code=>code===0?ok():fail(new Error('Geri yükleme başarısız: '+message)));})]);}finally{clearTimeout(timeout);}
  } else await pgTool(app,'pg_restore',['--no-password','--exit-on-error','--single-transaction','-d',dbName,join(root,'database.dump')]);
  const recoveryFiles=join(root,'recovery-files');await (await filesTool()).restoreFiles(recoveryFiles,join(root,'files.gz'));
  url.pathname='/'+dbName;
  const recovered=new pg.Pool({connectionString:url.toString(),max:1});
  try {
    const tables=await recovered.query("select count(*)::int as count from information_schema.tables where table_schema='public'");
    const companies=await recovered.query('select count(*)::int as count from companies');
    const organizations=await recovered.query('select id from organizations');
    if(organizations.rows.length!==1 || organizations.rows[0]?.id!==orgId) throw forbidden('Kurtarılan kuruluş doğrulanamadı.');
    return {database:dbName,tableCount:tables.rows[0].count,companyCount:companies.rows[0].count,fileCount:manifest.fileCount,stage:'verified',cutoverRequired:true};
  } finally {await recovered.end();}
}
async function queueBackup(c:BackupContext) {
  await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id+':backup-queue'},0))`);
  const pending=(await c.tx.execute(sql`select id from administration_runs where kind in ('backup','restore') and status in ('queued','running')`)).rows;
  if(pending.length) throw conflict('Bekleyen bir yedekleme veya kurtarma işlemi var.');
  const id=uuidv7();await c.tx.execute(sql`insert into administration_runs(id,company_id,kind,status,requested_by) values(${id},${c.company.id},'backup','queued',${c.user.id})`);return {id};
}
export async function queueAutomaticBackup(app:FastifyInstance,c:BackupContext,date:string) {
  try {
    await requireBackupOwner(app,c);
    const recent=(await c.tx.execute(sql`select id from administration_runs where kind='backup' and ((started_at at time zone ${c.company.timeZone})::date=${date}::date or status in ('queued','running')) limit 1`)).rows;
    if(!recent.length) await queueBackup(c);
  } catch(error) {app.log.warn({companyId:c.company.id,reason:error instanceof Error?error.message:'Yedekleme yapılandırılmamış'},'Otomatik yedek atlandı');}
}
export async function processBackupJobs(app:FastifyInstance) {
  if(!app.config.BACKUP_DATABASE_URL) return;
  const targets=(await app.db.execute<{company_id:string;organization_id:string}>(sql`select company_id,organization_id from notification_scan_targets()`)).rows;
  for(const t of targets) {
    let run:Run|undefined;
    await withContext(app.db,{companyId:t.company_id,orgId:t.organization_id},async tx=>{
      await tx.execute(sql`update administration_runs set status='failed',finished_at=now(),error='İşlem kesildi; yeni deneme başlatın.' where kind in ('backup','restore') and status='running' and started_at<now()-interval '20 minutes'`);
      run=(await tx.execute<Run>(sql`select id,kind,status,requested_by as "requestedBy",result from administration_runs where kind in ('backup','restore') and status='queued' order by started_at limit 1 for update skip locked`)).rows[0];
      if(!run) return;
      const m=(await tx.execute<{role:'owner'|'admin'}>(sql`select m.role from memberships m join users u on u.id=m.user_id where m.company_id=${t.company_id}::uuid and m.user_id=${run.requestedBy}::uuid and u.is_active`)).rows[0];
      const access=m ? await loadMemberAccess(tx,t.company_id,run.requestedBy,m.role) : null;
      if(!access?.permissions.has('company.manage') || !access.permissions.has('settings.manage')) {await tx.execute(sql`update administration_runs set status='failed',error='İşlemi isteyen kullanıcının sahip yetkisi kaldırıldı.',finished_at=now() where id=${run.id}::uuid`);run=undefined;return;}
      await tx.execute(sql`update administration_runs set status='running',started_at=now() where id=${run.id}::uuid`);
    });
    if(!run)continue;
    const current=run;
    try {
      const result=current.kind==='backup'?await makeBackup(app,t.organization_id,current.id):await restoreIsolated(app,t.organization_id,current.id);
      await withContext(app.db,{companyId:t.company_id,orgId:t.organization_id,userId:current.requestedBy},async tx=>{
        await tx.execute(sql`update administration_runs set status='succeeded',finished_at=now(),result=${JSON.stringify(result)}::jsonb where id=${current.id}::uuid`);
        if(current.kind==='backup') {
          const s=(await tx.execute<{settings:unknown}>(sql`select settings from company_operations_settings`)).rows[0];
          const keep=operationsSettingsSchema.parse(s?.settings??{}).backupKeepCount;
          const obsolete=(await tx.execute<{id:string}>(sql`select id from administration_runs where kind='backup' and status='succeeded' order by started_at desc offset ${keep}`)).rows;
          for(const old of obsolete) {await rm(folder(app,old.id),{recursive:true,force:true});await tx.execute(sql`update administration_runs set status='expired' where id=${old.id}::uuid`);}
        }
      });
    } catch(error) {
      const message=error instanceof Error?error.message.slice(0,1800):'Yedekleme işlemi başarısız.';
      await withContext(app.db,{companyId:t.company_id,orgId:t.organization_id,userId:current.requestedBy},async tx=>{await tx.execute(sql`update administration_runs set status='failed',finished_at=now(),error=${message} where id=${current.id}::uuid`);});
    }
  }
}
export const backupRoutes:FastifyPluginAsync=async app=>{
  const access={module:'core.settings',permission:'settings.manage'} as const;
  app.get('/api/settings/backups',tenantRoute(app,access,async c=>{
    c.require('company.manage');
    let available=true,reason:string|null=null,canRestore=false;
    try{canRestore=(await requireBackupOwner(app,c)).canRestore;}catch(error){available=false;reason=error instanceof Error?error.message:'Yedekleme yapılandırılmamış.';}
    const {settings,version}=await operationalSettings(c.tx);
    return {available,reason,canRestore,settings,version,maxPackageMb:128,items:(await c.tx.execute(sql`select id,kind,status,started_at as "startedAt",finished_at as "finishedAt",result,error from administration_runs where kind in ('backup','restore') order by started_at desc limit 100`)).rows};
  }));
  app.post('/api/settings/backups',tenantRoute(app,{...access,limit:{name:'backup-create',max:3,windowMs:60000}},async c=>{await requireBackupOwner(app,c);void c.reply.code(201);return queueBackup(c);}));
  app.get('/api/settings/backups/:id/download',tenantRoute(app,{...access,limit:{name:'backup-download',max:5,windowMs:60000}},async c=>{
    await requireBackupOwner(app,c);const {id}=idParam.parse(c.req.params);
    const run=(await c.tx.execute(sql`select id from administration_runs where id=${id}::uuid and kind='backup' and status='succeeded'`)).rows[0];
    if(!run) throw badRequest('Yedek indirmeye hazır değil.');
    if(!app.exportGate.tryAcquire()) throw new AppError(429,'EXPORT_BUSY','Başka bir dışa aktarma çalışıyor.');
    try{return c.reply.header('content-type','application/zip').header('content-disposition',`attachment; filename="erp-backup-${id}.zip"`).send(await packageBytes(app,id));}finally{app.exportGate.release();}
  }));
  app.post('/api/settings/backups/import',{bodyLimit:180000000},tenantRoute(app,{...access,limit:{name:'backup-upload',max:2,windowMs:60000}},async c=>{
    await requireBackupOwner(app,c);const {base64}=z.object({base64:z.string().min(40).max(179000000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).parse(c.req.body);
    if(!app.exportGate.tryAcquire()) throw new AppError(429,'EXPORT_BUSY','Başka bir dışa aktarma çalışıyor.');
    try{void c.reply.code(201);return await inspectBackupPackage(app,c,Buffer.from(base64,'base64'));}finally{app.exportGate.release();}
  }));
  app.post('/api/settings/backups/:id/restore',tenantRoute(app,access,async c=>{
    await requireBackupOwner(app,c);const {id}=idParam.parse(c.req.params),input=z.object({confirm:z.literal('AYRI KURTARMA VERİTABANI')}).parse(c.req.body);
    void input;
    const existing=(await c.tx.execute(sql`select id from administration_runs where kind in ('backup','restore') and status in ('running','queued')`)).rows;
    if(existing.length)throw conflict('Önce bekleyen işlemin bitmesini bekleyin.');
    const result=(await c.tx.execute(sql`update administration_runs set status='queued' where id=${id}::uuid and kind='restore' and status='staged' returning id`)).rows;
    if(!result.length)throw conflict('Yedek incelenmemiş veya daha önce kurtarma başlatılmış.');
    return {id};
  }));
};
