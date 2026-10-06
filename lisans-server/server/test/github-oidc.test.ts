import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubToken } from '../src/github-oidc';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const policy = { repositoryId: '12345', repository: 'er0s3c/muhasebe-erp', audience: 'muhasebe-erp-release', workflow: 'customer-release.yml' };
const now = 1_800_000_000_000;
const base = { iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, exp: now / 1000 + 300, nbf: now / 1000 - 5, repository_id: policy.repositoryId, repository: policy.repository, ref: 'refs/heads/main', workflow_ref: `${policy.repository}/.github/workflows/${policy.workflow}@refs/heads/main`, sha: 'a'.repeat(40), run_id: '100', run_attempt: '1' };
const token = (change = {}, algorithm = 'RS256') => { const h = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'test-key' })).toString('base64url'), b = Buffer.from(JSON.stringify({ ...base, ...change })).toString('base64url'); return `${h}.${b}.${sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`; };
const fetchKeys = (async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] }), { status: 200 })) as typeof fetch;
const verify = (value: string) => verifyGithubToken(value, policy, { now, fetch: fetchKeys });
describe('GitHub OIDC draft-upload identity', () => {
  it('accepts only the signed configured repository, workflow, main and audience', async () => { expect((await verify(token())).run_id).toBe('100'); });
  it.each([
    { repository_id: '54321' }, { repository: 'attacker/repo' }, { aud: 'other-service' }, { ref: 'refs/pull/1/merge' },
    { workflow_ref: `${policy.repository}/.github/workflows/evil.yml@refs/heads/main` }, { exp: now / 1000 - 1 }, { nbf: now / 1000 + 120 }, { exp: now / 1000 + 1800 },
  ])('rejects untrusted claims %j', async (claims) => { await expect(verify(token(claims))).rejects.toThrow(); });
  it('rejects changed signature and algorithm confusion', async () => {
    const parts = token().split('.'); parts[1] = Buffer.from(JSON.stringify({ ...base, repository_id: '54321' })).toString('base64url');
    await expect(verify(parts.join('.'))).rejects.toThrow(); await expect(verify(token({}, 'HS256'))).rejects.toThrow();
  });
});
