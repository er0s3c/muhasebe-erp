import { useState } from 'react';
import type { BranchContext,MemberBranchScopeInput } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card,CardHeader,PageHeader } from '../../components/ui/Card';
import { Field,Input,Select } from '../../components/ui/Field';
import { Callout,PageLoading } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan,useCMutation,useCQuery } from '../../lib/queries';

interface Branch {id:string;code:string;name:string;address:string|null;isActive:boolean;}
interface Member {userId:string;fullName:string;role:string;}
interface Resource {id:string;name:string;branchId:string|null;}

export function BranchesPage(){
 const can=useCan(),toast=useToast(),editable=can('company.manage');
 const branches=useCQuery<{branches:Branch[];scope:BranchContext}>(['branches'],'/api/company/branches',{branchId:'all'});
 const members=useCQuery<{members:Member[]}>(['members'],'/api/company/members',{enabled:can('members.manage'),branchId:'all'});
 const resources=useCQuery<{warehouses:Resource[];employees:Resource[]}>(['branch-resources'],'/api/company/branches/resources',{enabled:editable,branchId:'all'});
 const [code,setCode]=useState(''),[name,setName]=useState(''),[address,setAddress]=useState(''),[memberId,setMemberId]=useState('');
 const [targetBranch,setTargetBranch]=useState(''),[warehouseIds,setWarehouseIds]=useState<string[]>([]),[employeeIds,setEmployeeIds]=useState<string[]>([]);
 const memberScope=useCQuery<{scope:MemberBranchScopeInput}>(['branch-member',memberId],memberId?`/api/company/members/${memberId}/branches`:null,{branchId:'all'});
 const create=useCMutation((body:{code:string;name:string;address:string|null},call)=>call('/api/company/branches',{method:'POST',body,branchId:'all'}),[['branches']]);
 const assign=useCMutation((body:{branchId:string|null;warehouseIds:string[];employeeIds:string[]},call)=>call('/api/company/branch-assignments',{method:'POST',body,branchId:'all'}),[['branch-resources'],['warehouses'],['employees']]);
 const toggle=(values:string[],id:string,set:(next:string[])=>void)=>set(values.includes(id)?values.filter(v=>v!==id):[...values,id]);
 if(branches.isPending)return <PageLoading/>;
 if(branches.error||!branches.data)return <Callout tone="danger">{errorMessage(branches.error)}</Callout>;
 const list=branches.data.branches;
 const branchName=(id:string|null)=>id?list.find(b=>b.id===id)?.name??'Erişim dışındaki şube':'Şubeye atanmamış';
 return <>
  <PageHeader title="Şubeler" description="Depoları, personeli ve mali kayıtları şirketinizin şubeleriyle ilişkilendirin."/>
  <div className="space-y-5">
   <Callout>Eski şubesiz kayıtlar “Şubeye atanmamış” olarak korunur. Üst menüden bir şube seçtiğinizde yeni kayıtlar o şubede oluşturulur. Pasif şubelerin geçmişi okunabilir.</Callout>
   {editable&&<Card><CardHeader title="Şube oluştur"/><form className="grid gap-4 p-5 sm:grid-cols-2" onSubmit={async e=>{e.preventDefault();try{await create.mutateAsync({code,name,address:address.trim()||null});setCode('');setName('');setAddress('');toast.success('Şube oluşturuldu');}catch(error){toast.error(errorMessage(error));}}}>
    <Field label="Şube kodu" required>{id=><Input id={id} value={code} onChange={e=>setCode(e.target.value)} maxLength={20} required placeholder="MERKEZ"/>}</Field>
    <Field label="Şube adı" required>{id=><Input id={id} value={name} onChange={e=>setName(e.target.value)} maxLength={160} minLength={2} required/>}</Field>
    <Field label="Adres">{id=><Input id={id} value={address} onChange={e=>setAddress(e.target.value)} maxLength={500}/>}</Field>
    <div className="flex items-end"><Button type="submit" variant="primary" loading={create.isPending}>Şube oluştur</Button></div>
   </form></Card>}
   <div className="grid min-w-0 gap-4 md:grid-cols-2">{list.map(branch=><BranchEditor key={branch.id} branch={branch} editable={editable&&branches.data.scope.mode==='all'}/> )}</div>
   {!list.length&&<Callout>Henüz şube oluşturulmadı. Mevcut kayıtlar şubeye atanmamış olarak kullanılmaya devam eder.</Callout>}
   {editable&&resources.data&&<Card><CardHeader title="Depo ve personel şubesi" description="Hareket görmüş depo ve kesinleşmiş bordrolu personelin geçmiş şubesi doğrudan değiştirilemez."/>
    <form className="space-y-4 p-5" onSubmit={async e=>{e.preventDefault();try{await assign.mutateAsync({branchId:targetBranch||null,warehouseIds,employeeIds});setWarehouseIds([]);setEmployeeIds([]);toast.success('Şube ataması güncellendi');}catch(error){toast.error(errorMessage(error));}}}>
     <Field label="Atanacak şube">{id=><Select id={id} value={targetBranch} onChange={e=>setTargetBranch(e.target.value)}><option value="">Şubeye atanmamış</option>{list.filter(b=>b.isActive).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>
     <div className="grid gap-5 sm:grid-cols-2">
      <fieldset className="min-w-0"><legend className="mb-2 text-sm">Depolar</legend><div className="space-y-2">{resources.data.warehouses.map(r=><label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm" key={r.id}><input className="mt-0.5 size-4 shrink-0" type="checkbox" checked={warehouseIds.includes(r.id)} onChange={()=>toggle(warehouseIds,r.id,setWarehouseIds)}/><span className="min-w-0 break-words">{r.name}<span className="block text-xs text-muted">{branchName(r.branchId)}</span></span></label>)}</div></fieldset>
      <fieldset className="min-w-0"><legend className="mb-2 text-sm">Personel</legend><div className="space-y-2">{resources.data.employees.map(r=><label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm" key={r.id}><input className="mt-0.5 size-4 shrink-0" type="checkbox" checked={employeeIds.includes(r.id)} onChange={()=>toggle(employeeIds,r.id,setEmployeeIds)}/><span className="min-w-0 break-words">{r.name}<span className="block text-xs text-muted">{branchName(r.branchId)}</span></span></label>)}</div></fieldset>
     </div><Button type="submit" loading={assign.isPending} disabled={!warehouseIds.length&&!employeeIds.length}>Seçilenleri ata</Button>
    </form></Card>}
   {can('members.manage')&&<Card><CardHeader title="Üyelerin şube erişimi" description="Bir şube başlığı seçmek kullanıcının izinli kapsamını genişletmez."/><div className="space-y-4 p-5">
    <Field label="Üye">{id=><Select id={id} value={memberId} onChange={e=>setMemberId(e.target.value)}><option value="">Üye seçin</option>{members.data?.members.map(m=><option value={m.userId} key={m.userId}>{m.fullName}</option>)}</Select>}</Field>
    {memberScope.isPending&&memberId&&<PageLoading/>}{memberScope.error&&<Callout tone="danger">{errorMessage(memberScope.error)}</Callout>}
    {memberScope.data&&<MemberScopeEditor key={`${memberId}:${JSON.stringify(memberScope.data.scope)}`} userId={memberId} initial={memberScope.data.scope} branches={list} owner={members.data?.members.find(m=>m.userId===memberId)?.role==='owner'}/>}
   </div></Card>}
  </div>
 </>;
}

function BranchEditor({branch,editable}:{branch:Branch;editable:boolean}){
 const toast=useToast(),[name,setName]=useState(branch.name),[address,setAddress]=useState(branch.address??'');
 const update=useCMutation((body:{name?:string;address?:string|null;isActive?:boolean},call)=>call(`/api/company/branches/${branch.id}`,{method:'PATCH',body,branchId:'all'}),[['branches'],['navigation']]);
 const submit=async(body:{name?:string;address?:string|null;isActive?:boolean})=>{try{await update.mutateAsync(body);toast.success('Şube güncellendi');}catch(error){toast.error(errorMessage(error));}};
 return <Card><CardHeader title={branch.code} description={branch.isActive?'Etkin şube':'Pasif şube'}/><form className="space-y-3 p-5" onSubmit={e=>{e.preventDefault();void submit({name,address:address.trim()||null});}}>
  <Field label="Şube adı">{id=><Input id={id} value={name} minLength={2} maxLength={160} required disabled={!editable} onChange={e=>setName(e.target.value)}/>}</Field>
  <Field label="Adres">{id=><Input id={id} value={address} maxLength={500} disabled={!editable} onChange={e=>setAddress(e.target.value)}/>}</Field>
  {editable&&<div className="flex flex-wrap gap-2"><Button type="submit" loading={update.isPending}>Kaydet</Button><Button variant="ghost" disabled={update.isPending} onClick={()=>void submit({isActive:!branch.isActive})}>{branch.isActive?'Pasife al':'Etkinleştir'}</Button></div>}
 </form></Card>;
}

function MemberScopeEditor({userId,initial,branches,owner}:{userId:string;initial:MemberBranchScopeInput;branches:Branch[];owner:boolean}){
 const toast=useToast(),[mode,setMode]=useState(initial.mode),[ids,setIds]=useState(initial.branchIds),[allowUnassigned,setAllowUnassigned]=useState(initial.allowUnassigned);
 const save=useCMutation((body:MemberBranchScopeInput,call)=>call(`/api/company/members/${userId}/branches`,{method:'PUT',body,branchId:'all'}),[['branch-member',userId],['members'],['navigation'],['branches']]);
 if(owner)return <Callout>Şirket sahibi tüm şubelere ve şubeye atanmamış kayıtlara erişir.</Callout>;
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();try{await save.mutateAsync({mode,branchIds:mode==='all'?[]:ids,allowUnassigned:mode==='all'||allowUnassigned});toast.success('Şube erişimi güncellendi');}catch(error){toast.error(errorMessage(error));}}}>
  <Field label="Şube kapsamı">{id=><Select id={id} value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="all">Tüm şubeler</option><option value="restricted">Seçilen şubeler</option></Select>}</Field>
  {mode==='restricted'&&<fieldset className="space-y-3"><legend className="mb-2 text-sm">İzin verilen şubeler</legend>{branches.map(b=><label className="flex items-center gap-2 text-sm" key={b.id}><input className="size-4" type="checkbox" checked={ids.includes(b.id)} onChange={()=>setIds(ids.includes(b.id)?ids.filter(id=>id!==b.id):[...ids,b.id])}/>{b.name}{!b.isActive&&' (Pasif)'}</label>)}<label className="flex items-center gap-2 text-sm"><input className="size-4" type="checkbox" checked={allowUnassigned} onChange={e=>setAllowUnassigned(e.target.checked)}/>Şubeye atanmamış kayıtlar</label><p className="text-xs text-muted">Hiçbir şube ve şubesiz erişim seçilmezse bu üye şubeli mali kayıtlara erişemez.</p></fieldset>}
  <Button type="submit" loading={save.isPending}>Şube erişimini kaydet</Button>
 </form>;
}
