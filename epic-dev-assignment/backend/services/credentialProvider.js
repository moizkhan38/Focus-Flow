import { query } from '../db.js';
import { encryptJson, decryptJson, CURRENT_KEY_VERSION_OUT } from './cryptoService.js';

// Per-org integration credentials (Phase 2, step 2.3).
//
// The single gateway between org_integrations (encrypted at rest via
// cryptoService) and the rest of the backend. Decrypted secrets are handed out
// ONLY through getJiraCredentials / getGithubToken (consumed by the Jira/GitHub
// client factories in 2.5/2.6). getStatus never exposes secret material.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min; also the multi-instance staleness bound

// key `${orgId}:${provider}` -> { payload: object|null, expiresAt: number }
// Caches misses (null) too, so not-connected orgs don't hit the DB every request.
const cache = new Map();
const cacheKey = (orgId, provider) => `${orgId}:${provider}`;

// Thrown by the client factories when an org has no credentials for a provider.
// Downstream route handlers map this to HTTP 412 { error: '<PROVIDER>_NOT_CONNECTED' }.
export class IntegrationNotConnectedError extends Error {
  constructor(provider) {
    super(`${provider} integration is not connected for this organization`);
    this.name = 'IntegrationNotConnectedError';
    this.provider = provider;
    this.code = `${String(provider).toUpperCase()}_NOT_CONNECTED`;
  }
}

function bust(orgId, provider) {
  cache.delete(cacheKey(orgId, provider));
}

// Decrypted payload object for (org, provider), or null if not connected.
async function getPayload(orgId, provider) {
  const key = cacheKey(orgId, provider);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.payload;

  const { rows } = await query(
    'SELECT ciphertext FROM org_integrations WHERE org_id = $1 AND provider = $2',
    [orgId, provider]
  );
  const payload = rows.length ? decryptJson(rows[0].ciphertext) : null;
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}

export async function getJiraCredentials(orgId) {
  const p = await getPayload(orgId, 'jira');
  if (!p) return null;
  return { domain: p.domain, email: p.email, apiToken: p.apiToken };
}

export async function getGithubToken(orgId) {
  const p = await getPayload(orgId, 'github');
  return p ? p.token || null : null;
}

// Encrypt + upsert + invalidate cache. payloadObj shape:
//   jira   → { domain, email, apiToken }
//   github → { token, login }
export async function setIntegration(orgId, provider, payloadObj) {
  const ciphertext = encryptJson(payloadObj);
  await query(
    `INSERT INTO org_integrations (org_id, provider, ciphertext, key_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       ciphertext  = EXCLUDED.ciphertext,
       key_version = EXCLUDED.key_version`,
    [orgId, provider, ciphertext, CURRENT_KEY_VERSION_OUT]
  );
  bust(orgId, provider); // updated_at is maintained by the org_integrations_touch trigger
}

export async function deleteIntegration(orgId, provider) {
  const { rowCount } = await query(
    'DELETE FROM org_integrations WHERE org_id = $1 AND provider = $2',
    [orgId, provider]
  );
  bust(orgId, provider);
  return rowCount > 0;
}

// Non-secret connection status for the Settings UI. Domain/email/login are safe
// to surface; the token is reduced to its last 4 characters.
export async function getStatus(orgId) {
  const [jira, github] = await Promise.all([
    getPayload(orgId, 'jira'),
    getPayload(orgId, 'github'),
  ]);
  return {
    jira: jira
      ? { connected: true, domain: jira.domain, email: jira.email }
      : { connected: false },
    github: github
      ? { connected: true, login: github.login || null, tokenSuffix: (github.token || '').slice(-4) }
      : { connected: false },
  };
}
