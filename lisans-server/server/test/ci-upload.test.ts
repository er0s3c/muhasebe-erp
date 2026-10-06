import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@erp/license-core';
vi.mock('../src/github-oidc', () => ({ verifyGithubToken: async (token: string) => { if (token !== 'trusted-ci-test') throw new Error('bad token'); return { run_id: '100', run_attempt: '1' }; } }));
import { makeServer, adminClient } from './helpers';
const dir = mkdtempSync(join(tmpdir(), 'ci-upload-'));
const s = await makeServer({ env: { RELEASES_DIR: dir, GITHUB_REPOSITORY: 'er0s3c/muhasebe-erp', GITHUB_REPOSITORY_ID: '1395438415' } });
const admin = await adminClient(s);
const headers = { authorization: 'Bearer trusted-ci-test', 'content-type': 'application/octet-stream' };
describe('draft-only CI uploads and signed initial customer installer', () => {
  it('isolates CI from admin, resumes chunks, rejects corruption, publishes only by admin and expires downloads', async () => {
    const create = { version: '7.0.0', notes: 'CI test', sourceCommit: 'a'.repeat(40), testsPassed: true };
    expect((await admin.post('/ci/api/releases', create)).statusCode).toBe(401);
    const draft = await s.app.inject({ method: 'POST', url: '/ci/api/releases', headers, payload: JSON.stringify(create) });
    // JSON and raw chunk parsers stay separate.
    expect(draft.statusCode).toBe(400);
    const good = await s.app.inject({ method: 'POST', url: '/ci/api/releases', headers: { authorization: headers.authorization }, payload: create });
    expect(good.statusCode,good.body).toBe(200);const id = good.json().id;
    const put = (name: string, data: Buffer, offset = 0, final = '1', size = data.length, hash = createHash('sha256').update(data).digest('hex')) => s.app.inject({ method: 'PUT', url: `/ci/api/releases/${id}/files/${name}?offset=${offset}&size=${size}&sha256=${hash}&final=${final}`, headers, payload: data });
    const kit = Buffer.from('Windows kit test');const kitName = 'muhasebe-erp-7.0.0-win-x64.zip';const hash = createHash('sha256').update(kit).digest('hex');
    expect((await put(kitName, kit.subarray(0,5), 0, '0', kit.length, hash)).json().received).toBe(5);
    const resume = await put(kitName, kit, 0, '1', kit.length, hash);expect(resume.statusCode).toBe(409);expect(resume.json().error.details.expectedOffset).toBe(5);
    expect((await put(kitName, kit.subarray(5), 5, '1', kit.length, hash)).json().done).toBe(true);
    expect((await put(kitName,kit)).json().done).toBe(true);
    expect((await admin.post(`/admin/api/releases/${id}/publish`,{})).json().error.code).toBe('RELEASE_INCOMPLETE');
    const exe = Buffer.from('MZ synthetic installer');
    expect((await put('MuhasebeERP-Kurulum.exe', exe, 0,'1',exe.length,'b'.repeat(64))).statusCode).toBe(400);
    expect((await put('MuhasebeERP-Kurulum.exe',exe)).json().done).toBe(true);
    const published = await admin.post(`/admin/api/releases/${id}/publish`,{});expect(published.statusCode,published.body).toBe(200);
    const signed = verifyToken('installer',published.json().release.installerSignature,s.ring) as {file:{sha256:string}};expect(signed.file.sha256).toBe(createHash('sha256').update(exe).digest('hex'));
    expect((await put('MuhasebeERP-Kurulum.exe',exe)).statusCode).toBe(409);
    const link = await admin.post(`/admin/api/releases/${id}/installer-link`,{});expect(link.statusCode).toBe(200);
    const downloaded = await s.app.inject({method:'GET',url:link.json().url});expect(downloaded.statusCode).toBe(200);expect(downloaded.rawPayload).toEqual(exe);
    s.clock.t += 25*3600_000;expect((await s.app.inject({method:'GET',url:link.json().url})).statusCode).toBe(403);
  });
});
