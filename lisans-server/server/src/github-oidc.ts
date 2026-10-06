import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

const claimsSchema = z.object({ iss: z.literal('https://token.actions.githubusercontent.com'), aud: z.string(), exp: z.number(), nbf: z.number(), repository_id: z.string(), repository: z.string(), ref: z.literal('refs/heads/main'), workflow_ref: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/), run_id: z.string().regex(/^\d+$/), run_attempt: z.string().regex(/^\d+$/) });
export type GithubClaims = z.infer<typeof claimsSchema>;
const keysSchema = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('RSA'), n: z.string().max(2000), e: z.string().max(20) })).max(30) });
let cachedKeys: { until: number; promise: Promise<z.infer<typeof keysSchema>> } | undefined;
async function readKeys(fetcher: typeof fetch) {
  const response = await fetcher('https://token.actions.githubusercontent.com/.well-known/jwks', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('OIDC keys unavailable');
  const text = await response.text(); if (text.length > 100_000) throw new Error('OIDC keys size');
  return keysSchema.parse(JSON.parse(text));
}
export async function verifyGithubToken(token: string, policy: { repositoryId: string; repository: string; audience: string; workflow: string }, opts: { fetch?: typeof fetch; now?: number } = {}): Promise<GithubClaims> {
  if (token.length > 16000) throw new Error('OIDC size');
  const [head, body, sig, extra] = token.split('.'); if (!head || !body || !sig || extra) throw new Error('OIDC format');
  const header = z.object({ alg: z.literal('RS256'), kid: z.string().max(200) }).parse(JSON.parse(Buffer.from(head, 'base64url').toString()));
  if (!opts.fetch && (!cachedKeys || cachedKeys.until < Date.now())) cachedKeys = { until: Date.now() + 60_000, promise: readKeys(fetch) };
  const jwks = await (opts.fetch ? readKeys(opts.fetch) : cachedKeys!.promise);
  const jwk = jwks.keys.find((k) => k.kid === header.kid); if (!jwk) throw new Error('OIDC key');
  if (!verify('RSA-SHA256', Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) throw new Error('OIDC signature');
  const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
  const now = (opts.now ?? Date.now()) / 1000;
  if (claims.nbf > now + 30 || claims.exp <= now || claims.exp - claims.nbf > 900 || claims.repository_id !== policy.repositoryId || claims.repository !== policy.repository || claims.aud !== policy.audience || claims.workflow_ref !== `${policy.repository}/.github/workflows/${policy.workflow}@refs/heads/main`) throw new Error('OIDC policy');
  return claims;
}
