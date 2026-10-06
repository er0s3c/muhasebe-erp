import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = `erp-tunnel-test-${randomUUID().slice(0, 8)}`;
const stage = join(root, '.runtime', name);
const proxy = `${name}-proxy`;
const upstream = `${name}-upstream`;
const nodeImage = process.env.LICENSE_TEST_IMAGE ?? 'node:22-bookworm-slim';
const environment = {
  ...process.env, POSTGRES_PASSWORD: 'test-only', DB_OWNER_PASSWORD: 'test-only', DB_APP_PASSWORD: 'test-only',
  LICENSE_IMAGE: nodeImage, LICENSE_DOMAIN: 'admin.er0s3c.com', LICENSE_DATA_KEY: 'test-only-not-a-production-key',
  LICENSE_SIGNING_KEY_PASSPHRASE: 'test-only-passphrase',
  CLOUDFLARED_IMAGE: 'cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07',
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: environment, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (overlay) => JSON.parse(docker('compose', '--project-directory', stage,
  '-f', join(root, 'lisans-server/deploy/compose.runtime.yml'),
  '-f', join(root, `lisans-server/deploy/${overlay}`), 'config', '--format', 'json'));
await mkdir(stage, { recursive: true });
console.log('Tunnel Compose güvenliği ve gerçek Caddy HTTP akışı sınanıyor…');
try {
  const managed = compose('compose.managed-tunnel.yml');
  for (const service of Object.values(managed.services)) assert.equal(service.ports?.length ?? 0, 0, 'Managed Tunnel must publish no ports');
  const tunnel = managed.services.cloudflared;
  assert.ok(tunnel.image.includes('@sha256:'));
  assert.ok(tunnel.command.includes('--token-file'));
  assert.equal(tunnel.environment?.TUNNEL_TOKEN, undefined);
  assert.equal(tunnel.user, '65532:65532');
  assert.equal(tunnel.read_only, true);
  const host = compose('compose.host-tunnel.yml');
  assert.equal(host.services.caddy.ports[0].host_ip, '127.0.0.1');
  assert.equal(host.services.caddy.ports[0].published, '4080');
  docker('network', 'create', name);
  docker('run', '-d', '--name', upstream, '--network', name, '--network-alias', 'license',
    '--entrypoint', 'node', nodeImage, '-e',
    'require("http").createServer((q,r)=>{r.setHeader("Content-Type","application/json");r.end(JSON.stringify({path:q.url,ip:q.headers["x-forwarded-for"],proto:q.headers["x-forwarded-proto"]}))}).listen(4000,"0.0.0.0")');
  docker('run', '-d', '--name', proxy, '--network', name, '--network-alias', 'caddy',
    '-e', 'LICENSE_DOMAIN=admin.er0s3c.com', '-e', 'LICENSE_ADMIN_ALLOW=203.0.113.7/32',
    '--mount', `type=bind,source=${join(root, 'lisans-server/deploy/Caddyfile.tunnel')},target=/etc/caddy/Caddyfile,readonly`, 'caddy:2');
  const response = JSON.parse(docker('exec', upstream, 'node', '-e', `
    (async()=>{
      const get=(path,ip,host='admin.er0s3c.com')=>new Promise((resolve,reject)=>{
        require('http').get({hostname:'caddy',path,headers:{Host:host,'Cf-Connecting-IP':ip,'X-Forwarded-For':'192.0.2.99','X-Forwarded-Proto':'http'}},r=>{
          let body='';r.on('data',chunk=>body+=chunk);r.on('end',()=>resolve({status:r.statusCode,body,cache:r.headers['cache-control']}));
        }).on('error',reject);
      });
      for(let i=0;i<40;i++){try{await get('/healthz','198.51.100.9');break}catch(e){if(i===39)throw e;await new Promise(r=>setTimeout(r,250))}}
      console.log(JSON.stringify({
        public:await get('/v2/time','198.51.100.9'),
        denied:await get('/admin/api/me','198.51.100.9'),
        admin:await get('/admin/api/me','203.0.113.7'),
        wrongHost:await get('/healthz','203.0.113.7','untrusted.example'),
        ci:await get('/ci/api/releases','198.51.100.9'),
        download:await get('/downloads/1.0.0/file','198.51.100.9')
      }));
    })().catch(e=>{console.error(e.message);process.exit(1)})`));
  assert.equal(response.public.status, 200);
  assert.equal(response.public.cache, 'no-store');
  assert.deepEqual(JSON.parse(response.public.body), { path: '/v2/time', ip: '198.51.100.9', proto: 'https' });
  assert.equal(response.denied.status, 403);
  assert.equal(response.admin.status, 200);
  assert.equal(response.wrongHost.status, 421);
  assert.equal(response.ci.status, 200);
  assert.equal(response.download.status, 200);
  console.log('Başarılı: port izolasyonu, token dosyası, istemci IP/HTTPS, panel IP kısıtı, alan adı ve makine uçları.');
} finally {
  for (const container of [proxy, upstream]) { try { docker('rm', '-f', container); } catch { /* May not have been created. */ } }
  try { docker('network', 'rm', name); } catch { /* May not have been created. */ }
  await rm(stage, { recursive: true, force: true });
}
