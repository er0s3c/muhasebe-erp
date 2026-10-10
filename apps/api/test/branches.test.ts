import { describe,expect,it } from 'vitest';
import { todayIso } from '@erp/shared';
import { accountIds,addMember,asDb,client,createCompany,expectDbError,makeApp,orgOf,registerUser } from './helpers';

describe('şube seçimi ve satır kapsamı',async()=>{
 const {app,handle}=await makeApp();
 const setup=async()=>{
  const session=await registerUser(app,'Sube'),company=await createCompany(app,session.token,{jurisdiction:'TR'}),c=client(app,session.token,company.id);
  const a=(await c.post('/api/company/branches',{code:'MERKEZ',name:'Merkez'})).json().branch;
  const b=(await c.post('/api/company/branches',{code:'MAGAZA',name:'Mağaza'})).json().branch;
  const call=(method:'GET'|'POST'|'PATCH',url:string,branchId:string,payload?:object,token=session.token)=>app.inject({method,url,payload,headers:{authorization:`Bearer ${token}`,'x-company-id':company.id,'x-branch-id':branchId}});
  return {session,company,c,a,b,call};
 };
 it('şube CRUD, pasif şube ve eski atanmamış depo korunur',async()=>{
  const {c,call,a}=await setup();
  expect((await c.get('/api/company/branches')).json().branches).toHaveLength(2);
  expect((await c.get('/api/warehouses')).json().warehouses[0].branchId).toBeNull();
  const warehouse=await call('POST','/api/warehouses',a.id,{code:'DEPOA',name:'Şube deposu'});
  expect(warehouse.statusCode).toBe(201);
  expect(warehouse.json().warehouse.branchId).toBe(a.id);
  expect((await c.patch(`/api/company/branches/${a.id}`,{isActive:false})).statusCode).toBe(200);
  expect((await call('POST','/api/warehouses',a.id,{code:'YENI',name:'Pasif depo'})).statusCode).toBe(422);
  expect((await call('GET','/api/warehouses',a.id)).statusCode).toBe(200);
 });
 it('yeni personel ve depo seçilen şubeyi taşır; atama sınırı şirket bazlıdır',async()=>{
  const {c,call,a,b}=await setup();
  const employee=await call('POST','/api/employees',a.id,{fullName:'Şube Personeli',hireDate:todayIso()});
  expect(employee.statusCode).toBe(201);
  expect(employee.json().employee.branchId).toBe(a.id);
  const warehouses=(await c.get('/api/warehouses')).json().warehouses;
  expect((await c.post('/api/company/branch-assignments',{branchId:b.id,warehouseIds:[warehouses[0].id]})).statusCode).toBe(200);
  expect((await call('GET','/api/warehouses',b.id)).json().warehouses).toHaveLength(1);
 });
 it('fatura ve otomatik yevmiye kaynak şubesini saklar',async()=>{
  const {c,call,a}=await setup();
  const party=(await c.post('/api/parties',{name:'Şube Alıcısı',kind:'customer'})).json().party;
  const invoice=await call('POST','/api/invoices',a.id,{type:'sales',invoiceDate:todayIso(),partyId:party.id,currency:'TRY',post:true,lines:[{description:'Hizmet',quantity:'1',unitPrice:'100',vatCode:'KDV-20'}]});
  expect(invoice.statusCode).toBe(201);
  const row=invoice.json().invoice;
  expect(row.branchId).toBe(a.id);
  const journal=(await call('GET',`/api/journal-entries/${row.journalEntryId}`,a.id)).json().entry;
  expect(journal.branchId).toBe(a.id);
  // Otomatik kaydın şubesi de seçili kapsamdan okunabilir.
  expect((await call('GET',`/api/invoices/${row.id}`,'unassigned')).statusCode).toBe(404);
 });
 it('başlıksız istek sınırlı üyeye yalnız izinli kayıtları verir; başlık yetkiyi genişletemez',async()=>{
  const {session,company,c,call,a,b}=await setup(),ids=await accountIds(app,session.token,company.id);
  const post=(id:string)=>call('POST','/api/journal-entries',id,{entryDate:todayIso(),description:'Şubeli yevmiye',post:true,lines:[{accountId:ids['100'],currency:'TRY',debit:'10'},{accountId:ids['500'],currency:'TRY',credit:'10'}]});
  expect((await post(a.id)).statusCode).toBe(201);expect((await post(b.id)).statusCode).toBe(201);
  const member=await addMember(app,c,company.id,'admin','SubeAdmin');
  expect((await c.put(`/api/company/members/${member.userId}/branches`,{mode:'restricted',branchIds:[a.id],allowUnassigned:false})).statusCode).toBe(200);
  expect((await call('GET','/api/journal-entries',b.id,undefined,member.token)).statusCode).toBe(403);
  const all=await member.client.get('/api/journal-entries');expect(all.statusCode).toBe(200);
  expect(all.json().entries).toHaveLength(1);
  for(const path of ['/api/social-security/declarations','/api/treasury/accounts/'+a.id+'/reconciliation','/api/exports/full-data','/api/exports/payroll-register','/api/fiscal-years']){
   const denied=await member.client.get(path);expect(denied.statusCode,path).toBe(403);expect(denied.json().error.code,path).toBe('BRANCH_COMPANY_WIDE_DENIED');
  }
  expect((await call('GET','/api/payroll/runs',a.id)).statusCode).toBe(403);
  await asDb(handle,{userId:member.userId,orgId:await orgOf(app,member.token),companyId:company.id},async(q)=>{
   expect((await q('select id from journal_entries where branch_id=$1',[b.id])).rows).toHaveLength(0);
   await q("select set_config('app.branch_id',$1,true),set_config('app.branch_selection','branch',true)",[b.id]);
   expect((await q('select id from journal_entries')).rows).toHaveLength(0);
  });
  expect((await member.client.put(`/api/company/members/${member.userId}/branches`,{mode:'all',branchIds:[],allowUnassigned:true})).statusCode).toBe(403);
 });
 it('başka şirket şubesine FK/RLS üzerinden kayıt bağlanamaz',async()=>{
  const a=await setup(),b=await setup();
  expect((await a.c.post('/api/company/branch-assignments',{branchId:b.a.id,warehouseIds:[(await a.c.get('/api/warehouses')).json().warehouses[0].id]})).statusCode).toBe(422);
  await asDb(handle,{userId:a.session.userId,orgId:await orgOf(app,a.session.token),companyId:a.company.id},async(q)=>{
   const warehouse=(await q('select id from warehouses limit 1')).rows[0];
   expect((await expectDbError(q,'update warehouses set branch_id=$1 where id=$2',[b.a.id,warehouse.id])).code).toBe('ERP24');
  });
 });
 it('şirket geneli definer yardımcıları etkin şubeden bağımsızdır ve başka şirketi açıklamaz',async()=>{
  const current=await setup(),other=await setup(),ids=await accountIds(app,current.session.token,current.company.id);
  expect((await current.call('POST','/api/journal-entries',current.b.id,{entryDate:todayIso(),description:'Diğer şubenin geçmişi',post:true,lines:[{accountId:ids['100'],currency:'TRY',debit:'10'},{accountId:ids['500'],currency:'TRY',credit:'10'}]})).statusCode).toBe(201);
  await asDb(handle,{userId:current.session.userId,orgId:await orgOf(app,current.session.token),companyId:current.company.id},async(q)=>{
   await q("select set_config('app.branch_id',$1,true),set_config('app.branch_selection','branch',true)",[current.a.id]);
   expect((await q('select id from journal_entries')).rows).toHaveLength(0);
   expect((await q('select company_has_finalized_records($1) as present',[current.company.id])).rows[0].present).toBe(true);
   expect((await q('select app_branch_has_access($1,$2) as allowed',[other.company.id,other.a.id])).rows[0].allowed).toBe(false);
   expect((await expectDbError(q,'select company_has_finalized_records($1)',[other.company.id])).code).toBe('ERP26');
   expect((await expectDbError(q,'select document_tax_rule_last_used_date($1,$2)',[other.company.id,other.a.id])).code).toBe('ERP26');
  });
 });
 it('kısıtlı yönetici yeni üyede aynı kapsamı korur ve ham üyelik/modül grantı kapsamı büyütemez',async()=>{
  const {session,company,c,a,b}=await setup();
  const admin=await addMember(app,c,company.id,'admin','SubeYetki'),outside=await addMember(app,c,company.id,'viewer','SubeDisinda');
  expect((await c.put(`/api/company/members/${admin.userId}/branches`,{mode:'restricted',branchIds:[a.id],allowUnassigned:false})).statusCode).toBe(200);
  const added=await addMember(app,admin.client,company.id,'viewer','AyniSube');
  const scope=(await c.get(`/api/company/members/${added.userId}/branches`)).json().scope;
  expect(scope).toEqual({mode:'restricted',branchIds:[a.id],allowUnassigned:false});
  await asDb(handle,{userId:admin.userId,orgId:await orgOf(app,session.token),companyId:company.id},async(q)=>{
   expect((await expectDbError(q,"update memberships set branch_scope_mode='all' where company_id=$1 and user_id=$2",[company.id,added.userId])).code).toBe('ERP26');
   expect((await expectDbError(q,"insert into member_module_access(id,company_id,user_id,module_key,level,set_by) values(gen_random_uuid(),$1,$2,'core.invoices','write',$3)",[company.id,outside.userId,admin.userId])).code).toBe('ERP26');
   expect((await expectDbError(q,'insert into member_branch_access(company_id,user_id,branch_id) values($1,$2,$3)',[company.id,added.userId,b.id])).code).toBe('ERP26');
  });
 });
 it('şube erişimi olan üyenin kendi üyeliğini kaldırması grantları cascade temizler',async()=>{
  const {company,c,a}=await setup(),admin=await addMember(app,c,company.id,'admin','SubeAyrilma');
  await c.put(`/api/company/members/${admin.userId}/branches`,{mode:'restricted',branchIds:[a.id],allowUnassigned:false});
  expect((await admin.client.delete(`/api/company/members/${admin.userId}`)).statusCode).toBe(200);
  expect((await c.get('/api/company/members')).json().members.some((m:{userId:string})=>m.userId===admin.userId)).toBe(false);
 });
});
