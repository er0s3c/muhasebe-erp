import { it,expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync,unzipSync } from 'fflate';
import { runMigrations } from '../src/db/migrate';
import { makeApp,registerUser,createCompany,client } from './helpers';
import { processBackupJobs } from '../src/modules/administration/backups';
import { storeAsset } from '../src/modules/construction-control/storage';

// Uses a completely separate database; never restores over erp_dev or erp_test.
it.skipIf(process.env.RUN_BACKUP_INTEGRATION!=='1')('gerçek pg_dump → imzalı paket → ayrı pg_restore; ek dosyalar ve bozuk paket',async()=>{
  const name='erp_backup_test_'+randomUUID().replaceAll('-','');
  const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'postgres://erp:erp@localhost:5432/erp_test');
  const admin=new pg.Pool({connectionString:ownerUrl.toString(),max:1});
  await admin.query(`create database "${name}" template template0`);
  ownerUrl.pathname='/'+name;
  const runtime=new URL(process.env.DATABASE_URL??'postgres://erp_app:erp_app@localhost:5432/erp_test');runtime.pathname='/'+name;
  const root=await mkdtemp(join(tmpdir(),'erp-backup-integration-'));
  let recoveredName:string|undefined;
  let cleanup:()=>Promise<void>=async()=>{};
  try {
    await runMigrations(ownerUrl.toString());
    const {app,handle}=await makeApp({configOverrides:{DATABASE_URL:runtime.toString(),BACKUP_DATABASE_URL:ownerUrl.toString(),BACKUP_DIRECTORY:join(root,'backups'),CONSTRUCTION_STORAGE_DIR:join(root,'files'),BACKUP_DOCKER_CONTAINER:process.env.BACKUP_TEST_DOCKER_CONTAINER}});
    cleanup=async()=>{await app.close();await handle.close();};
    const user=await registerUser(app,'Recovery'),company=await createCompany(app,user.token,{sector:'MANUFACTURING_WHOLESALE'}),c=client(app,user.token,company.id);
    const machine=await c.post('/api/manufacturing/resources',{code:'RECOVERY-MACHINE',name:'Yedekten dönen üretim makinesi',type:'machine'});expect(machine.statusCode,machine.body).toBe(200);
    const data=Buffer.from('%PDF-1.4 recovery test'),fileHash=await storeAsset(join(root,'files'),company.id,data);
    const rights=await c.get('/api/settings/backups');expect(rights.statusCode,rights.body).toBe(200);expect(rights.json().available).toBe(true);expect(rights.json().canRestore).toBe(true);
    const queued=await c.post('/api/settings/backups');expect(queued.statusCode,queued.body).toBe(201);
    await processBackupJobs(app);
    const listed=(await c.get('/api/settings/backups')).json();expect(listed.items[0].status,JSON.stringify(listed.items[0])).toBe('succeeded');
    const archive=await c.get(`/api/settings/backups/${queued.json().id}/download`);expect(archive.statusCode,archive.body).toBe(200);
    const entries=unzipSync(archive.rawPayload);
    const corrupt={...entries,'database.dump':Buffer.from('PGDMP invalid')};
    const rejected=await c.post('/api/settings/backups/import',{base64:Buffer.from(zipSync(corrupt,{level:0})).toString('base64')});expect(rejected.statusCode,rejected.body).toBe(400);
    const unknown={...entries,'../unsafe':Buffer.from('test')};expect((await c.post('/api/settings/backups/import',{base64:Buffer.from(zipSync(unknown,{level:0})).toString('base64')})).statusCode).toBe(400);
    const staged=await c.post('/api/settings/backups/import',{base64:archive.rawPayload.toString('base64')});expect(staged.statusCode,staged.body).toBe(201);
    const restore=await c.post(`/api/settings/backups/${staged.json().id}/restore`,{confirm:'AYRI KURTARMA VERİTABANI'});expect(restore.statusCode,restore.body).toBe(200);
    await processBackupJobs(app);
    const result=(await c.get('/api/settings/backups')).json().items.find((r:{id:string})=>r.id===staged.json().id);
    recoveredName='erp_recovery_'+staged.json().id.replaceAll('-','');
    expect(result.status,JSON.stringify(result)).toBe('succeeded');expect(result.result.tableCount).toBeGreaterThan(160);expect(result.result.companyCount).toBe(1);expect(result.result.fileCount).toBe(1);
    expect(await readFile(join(root,'backups',staged.json().id,'recovery-files',company.id,fileHash))).toEqual(data);
    const recoveryUrl=new URL(ownerUrl);recoveryUrl.pathname='/'+recoveredName;
    const check=new pg.Pool({connectionString:recoveryUrl.toString(),max:1});
    try{expect((await check.query('select name from companies')).rows[0].name).toBe(company.name);expect((await check.query("select config->>'name' as name from manufacturing_records where kind='resource'")).rows[0].name).toBe('Yedekten dönen üretim makinesi');}finally{await check.end();}
    const before=(await c.get('/api/settings/operations')).json();
    expect((await c.put('/api/settings/operations',{version:before.version,settings:{...before.settings,automaticBackup:true,backupKeepCount:1}})).statusCode).toBe(200);
    const second=await c.post('/api/settings/backups');expect(second.statusCode).toBe(201);await processBackupJobs(app);
    expect((await c.get('/api/settings/backups')).json().items.find((r:{id:string})=>r.id===queued.json().id).status).toBe('expired');
    // A second organization must immediately disable installation-wide access.
    await registerUser(app,'AnotherOrg');const isolated=await c.get('/api/settings/backups');expect(isolated.json().available).toBe(false);expect((await c.get(`/api/settings/backups/${second.json().id}/download`)).statusCode).toBe(403);
  } finally {
    await cleanup();
    for(const target of [recoveredName,name].filter(Boolean)) {
      const sessions=await admin.query('select pid from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',[target]);
      for(const row of sessions.rows)await admin.query('select pg_terminate_backend($1)',[row.pid]);
      await admin.query(`drop database if exists "${target}"`);
    }
    await admin.end();
    // Preserve the temporary artifacts to make an integration failure inspectable.
    await mkdir(root,{recursive:true});await writeFile(join(root,'integration-result.txt'),'Only disposable databases were used.');
  }
},120000);
