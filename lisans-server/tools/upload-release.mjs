import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
const url = process.env.LICENSE_SERVER_URL;
if (!url?.startsWith('https://')) throw new Error('LICENSE_SERVER_URL https olmalı');
const version = process.env.RELEASE_VERSION;
const sourceCommit = process.env.RELEASE_COMMIT;
let token;
async function oidc() {
  const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL); endpoint.searchParams.set('audience','muhasebe-erp-release');
  const res = await fetch(endpoint,{ headers:{ Authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },signal:AbortSignal.timeout(15000) });
  if(!res.ok)throw new Error('GitHub OIDC alınamadı'); token=(await res.json()).value;
}
async function request(path,method,body,raw=false){
  await oidc();
  const response=await fetch(`${url}${path}`,{ method,headers:{Authorization:`Bearer ${token}`,'content-type':raw?'application/octet-stream':'application/json'},body:raw?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(120000) });
  const result=await response.json();
  if(!response.ok){const error=new Error(`Taslak yüklemesi başarısız: ${response.status}`);error.expectedOffset=result?.error?.details?.expectedOffset;throw error;}return result;
}
const draft=await request('/ci/api/releases','POST',{version,sourceCommit,notes:process.env.RELEASE_NOTES??'',testsPassed:true});
for(const file of process.argv.slice(2)){
  const size=(await stat(file)).size;const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);const sha=hash.digest('hex');
  const handle=await open(file,'r');let retries=0;
  try{for(let offset=0;offset<size;){
    const bytes=Buffer.alloc(Math.min(draft.chunkBytes,size-offset));const {bytesRead}=await handle.read(bytes,0,bytes.length,offset);if(!bytesRead)throw new Error('Paket erken bitti');
    const final=offset+bytesRead===size?'1':'0';const query=new URLSearchParams({offset:String(offset),size:String(size),sha256:sha,final});
    try{const result=await request(`/ci/api/releases/${draft.id}/files/${basename(file)}?${query}`,'PUT',bytes.subarray(0,bytesRead),true);offset=result.received;retries=0;}
    catch(error){if(++retries>5)throw error;if(Number.isSafeInteger(error.expectedOffset)&&error.expectedOffset>=0&&error.expectedOffset<size)offset=error.expectedOffset;else await new Promise(resolve=>setTimeout(resolve,2000*retries));}
  }}finally{await handle.close();}
}
console.log(`Taslak sürüm hazır: ${version}. Panelden test müşterisini seçip yayımlayın; otomatik gönderim yapılmadı.`);
