import { describe, expect, it } from 'vitest';
import { useLicenseDatabase, useLicensedApp } from './license-helpers';
useLicenseDatabase();
const TOKEN='installation-setup-test-token-32-characters';
describe('one-use Windows owner bootstrap', () => {
  const t=useLicensedApp({configOverrides:{REGISTRATION_ENABLED:false,INSTALLATION_SETUP_TOKEN:TOKEN}});
  it('requires an activated license, loopback and secret; cannot create another owner afterwards', async () => {
    const c=t.ctx;const body={organizationName:'Kurulum Firması',fullName:'Kurulum Sahibi',email:'setup-owner@example.com',password:'Test-Kurulum-5739!'};
    const request=(token=TOKEN,remoteAddress='127.0.0.1',email=body.email)=>c.app.inject({method:'POST',url:'/api/auth/register',remoteAddress,headers:{'x-installation-setup':token},payload:{...body,email}});
    expect((await request()).statusCode).toBe(402);
    const license=c.vendor.issue();await c.service.activate(license.code);
    expect((await request('wrong')).statusCode).toBe(403);
    expect((await request(TOKEN,'192.168.1.50')).statusCode).toBe(403);
    const created=await request();expect(created.statusCode,created.body).toBe(201);
    expect((await request(TOKEN,'127.0.0.1','second-owner@example.com')).json().error.code).toBe('SETUP_COMPLETED');
    expect((await c.app.inject({method:'POST',url:'/api/auth/register',payload:{...body,email:'ordinary@example.com'}})).statusCode).toBe(403);
  });
});
