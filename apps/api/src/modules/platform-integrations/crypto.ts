import { createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';

export const newSecret=()=>randomBytes(32).toString('base64url');
export function apiKeyHash(token:string,secret:string){return createHmac('sha256',secret).update('company-api-key-v1:'+token).digest('hex');}
export function sameHash(a:string,b:string){return /^[0-9a-f]{64}$/.test(a)&&/^[0-9a-f]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export function canonicalJson(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canonicalJson(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const requestHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function webhookSignature(secret:string,timestamp:string,eventId:string,body:string){return 'v1='+createHmac('sha256',secret).update(timestamp+'.'+eventId+'.'+body).digest('hex');}
