import { useState } from 'react';
import { type CashScenarioInput } from '@erp/shared';
import { useCMutation,useCQuery,useCan } from '../../lib/queries';
import { PageHeader,Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { moneyIn } from '../../lib/format';
type Row={week:number;closing:string;inflow:string;outflow:string};
type Result={assumptions:CashScenarioInput;baseline:{opening:string;missingRate:number;baseCurrency:string;buckets:Row[]};scenario:{buckets:Row[];closing:string;lowest:string;movedBeyondHorizon:{inflow:string;outflow:string}}};
export function ScenariosPage(){
  const [input,setInput]=useState<CashScenarioInput>({name:'Tahsilat gecikmesi',delayDays:30,outflowIncreasePct:15,weeks:13});
  const preview=useCMutation((v:CashScenarioInput,call)=>call<Result>('/api/workspace/cash-scenarios/preview',{method:'POST',body:v}));
  const save=useCMutation((v:CashScenarioInput,call)=>call('/api/workspace/cash-scenarios',{method:'POST',body:v}),[['cash-scenarios']]);
  const saved=useCQuery<{items:{id:string;name:string;assumptions:CashScenarioInput}[]}>(['cash-scenarios'],'/api/workspace/cash-scenarios');
  const canSave=useCan()('treasury.manage');const result=preview.data;
  return <><PageHeader title="Nakit senaryoları" description="Girişlerin gecikmesini ve tüm nakit çıkışlarının artmasını mevcut projeksiyonla karşılaştırın. Varsayımlar muhasebe kayıtlarını değiştirmez."/>
    {(preview.error||save.error||saved.error)&&<Callout tone="danger">{(preview.error??save.error??saved.error)?.message}</Callout>}
    <Card className="mb-5 p-5"><form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={e=>{e.preventDefault();preview.mutate(input);}}>
      <label className="text-sm">Senaryo adı<Input required value={input.name} onChange={e=>setInput({...input,name:e.target.value})}/></label>
      <label className="text-sm">Giriş gecikmesi (gün)<Input type="number" min={0} max={365} value={input.delayDays} onChange={e=>setInput({...input,delayDays:Number(e.target.value)})}/></label>
      <label className="text-sm">Nakit çıkışı artışı (%)<Input type="number" min={0} max={500} step="any" value={input.outflowIncreasePct} onChange={e=>setInput({...input,outflowIncreasePct:Number(e.target.value)})}/></label>
      <label className="text-sm">Hafta<Input type="number" min={1} max={26} value={input.weeks} onChange={e=>setInput({...input,weeks:Number(e.target.value)})}/></label>
      <div className="flex gap-2"><Button variant="primary" type="submit" disabled={preview.isPending}>Karşılaştır</Button>{canSave&&<Button disabled={save.isPending} onClick={()=>save.mutate(input)}>Varsayımları sakla</Button>}</div>
    </form>{save.isSuccess&&<p role="status" className="mt-3 text-sm">Senaryo varsayımları saklandı.</p>}</Card>
    <div className="mb-4 flex flex-wrap gap-2">{saved.data?.items.map(s=><Button key={s.id} onClick={()=>{setInput(s.assumptions);preview.mutate(s.assumptions);}}>{s.name}</Button>)}</div>
    {result&&<><h2 className="mb-3 font-semibold">{result.assumptions.name}: {result.assumptions.delayDays} gün gecikme, %{result.assumptions.outflowIncreasePct} çıkış artışı</h2>
      {result.baseline.missingRate>0&&<Callout tone="warning">{result.baseline.missingRate} kalemde güncel kur eksik; karşılaştırma yaklaşık değer içerir.</Callout>}
      <div className="mb-4 grid gap-4 sm:grid-cols-3"><Card className="p-4">Senaryo sonu: {moneyIn(result.scenario.closing,result.baseline.baseCurrency)}</Card><Card className="p-4">En düşük bakiye: {moneyIn(result.scenario.lowest,result.baseline.baseCurrency)}</Card><Card className="p-4">Dönem dışına kayan giriş: {moneyIn(result.scenario.movedBeyondHorizon.inflow,result.baseline.baseCurrency)}</Card></div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-3 text-left">Hafta</th><th>Mevcut kapanış</th><th>Senaryo kapanış</th><th>Fark</th></tr></thead><tbody>{result.scenario.buckets.map((b,i)=><tr key={b.week} className="border-t border-border"><td className="p-3">{b.week}</td><td className="text-center">{moneyIn(result.baseline.buckets[i]!.closing,result.baseline.baseCurrency)}</td><td className="text-center">{moneyIn(b.closing,result.baseline.baseCurrency)}</td><td className="text-center">{moneyIn(String(Number(b.closing)-Number(result.baseline.buckets[i]!.closing)),result.baseline.baseCurrency)}</td></tr>)}</tbody></table></div>
      <p className="mt-3 text-sm text-muted">Karşılaştırma seçilen dönemdeki kaynak kalemleri kullanır. Zaten dönem dışında olan kalemler bu tablonun dışında kalır.</p>
    </>}
  </>;
}
