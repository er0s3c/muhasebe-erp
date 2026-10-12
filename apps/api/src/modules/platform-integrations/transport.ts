import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList,isIP } from 'node:net';
import { unprocessable } from '../../http/errors';

const denied=new BlockList();
for(const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)denied.addSubnet(address,bits,'ipv4');
denied.addSubnet('2001::',23,'ipv6');denied.addSubnet('2001:db8::',32,'ipv6');denied.addSubnet('2002::',16,'ipv6');denied.addSubnet('3fff::',20,'ipv6');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(address:string):boolean{const family=isIP(address);return family===4?!denied.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!denied.check(address,'ipv6');}
export function webhookUrl(raw:string):URL{
 let url:URL;try{url=new URL(raw);}catch{throw unprocessable('Bildirim adresi geçersiz','WEBHOOK_URL_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hash)throw unprocessable('Bildirim adresi HTTPS ve 443 bağlantı noktasını kullanmalı','WEBHOOK_URL_INVALID');
 return url;
}
export interface WebhookTransport {validate(url:string):Promise<void>;send(url:string,headers:Record<string,string>,body:string):Promise<number>;}
async function resolveEndpoint(raw:string){const url=webhookUrl(raw),host=url.hostname.replace(/^\[|\]$/g,''),addresses=await lookup(host,{all:true,verbatim:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw unprocessable('Bildirim adresi yalnız genel internet adreslerine çözümlenmeli','WEBHOOK_ADDRESS_PRIVATE');return {url,host,address:addresses[0]!};}
export const secureWebhookTransport:WebhookTransport={
 validate:async(url)=>{await resolveEndpoint(url);},
 send:async(raw,headers,body)=>{
  const {url,host,address}=await resolveEndpoint(raw);
  return new Promise<number>((resolve,reject)=>{
   const req=request({protocol:'https:',hostname:host,port:443,path:url.pathname+url.search,method:'POST',servername:isIP(host)?undefined:host,family:address.family,lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family),rejectUnauthorized:true,timeout:10000,headers:{...headers,'content-type':'application/json','content-length':String(Buffer.byteLength(body))}},res=>{
    let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536)req.destroy(new Error('Webhook yanıt boyutu sınırı aşıldı'));});res.on('end',()=>resolve(res.statusCode??0));res.on('error',reject);
   });req.on('timeout',()=>req.destroy(new Error('Webhook zaman aşımı')));req.on('error',reject);req.end(body);
  });
 },
};
