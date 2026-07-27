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
  // (orgId, provider) is passed as GCM additional authenticated data, so a
  // ciphertext copied into a different row fails to authenticate rather than
  // decrypting into the wrong tenant's client. See cryptoService.aad().
  const payload = rows.length ? decryptJson(rows[0].ciphertext, { orgId, provider }) : null;
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

// OPTIONAL GitHub organization that should own repositories created for this
// org's projects. null means "the token owner's own account" — the two are
// different GitHub endpoints, so the caller has to know which.
export async function getGithubOwner(orgId) {
  const p = await getPayload(orgId, 'github');
  return p ? p.owner || null : null;
}

// OPTIONAL per-org Gemini key (D5: the platform key remains the default).
// Returns null when the org hasn't connected one, which the caller treats as
// "use the platform key" rather than as an error.
export async function getGeminiKey(orgId) {
  const p = await getPayload(orgId, 'gemini');
  return p ? p.apiKey || null : null;
}

// Slack credentials for the standup bot. Unlike Jira/GitHub these are consumed
// by a separate Python service, so they leave this process over the
// internal-key-gated /api/internal/slack-config lane rather than through a
// client factory here.
export async function getSlackCredentials(orgId) {
  const p = await getPayload(orgId, 'slack');
  if (!p) return null;
  return {
    botToken: p.botToken,
    signingSecret: p.signingSecret,
    analyzerUrl: p.analyzerUrl || null,
    teamName: p.teamName || null,
  };
}

// Encrypt + upsert + invalidate cache. payloadObj shape:
//   jira   → { domain, email, apiToken }
//   github → { token, login }
//   slack  → { botToken, signingSecret, analyzerUrl?, teamName? }
export async function setIntegration(orgId, provider, payloadObj) {
  const ciphertext = encryptJson(payloadObj, { orgId, provider });
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
// One unreadable envelope must not take down the whole Settings page — that page
// is the only way to reconnect the provider and fix it. A decrypt failure now
// means "not connected" for that provider alone. Failures here are notable: with
// context binding in place they indicate a wrong master key or a ciphertext that
// was moved between rows.
function hostOf(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

async function safePayload(orgId, provider) {
  try {
    return await getPayload(orgId, provider);
  } catch (err) {
    console.error(
      `[credentialProvider] ${provider} credentials for ${orgId} failed to decrypt: ${err.message}`
    );
    return null;
  }
}

export async function getStatus(orgId) {
  const [jira, github, slack, gemini] = await Promise.all([
    safePayload(orgId, 'jira'),
    safePayload(orgId, 'github'),
    safePayload(orgId, 'slack'),
    safePayload(orgId, 'gemini'),
  ]);
  return {
    jira: jira
      ? { connected: true, domain: jira.domain, email: jira.email }
      : { connected: false },
    github: github
      ? {
          connected: true,
          login: github.login || null,
          owner: github.owner || null, // GitHub org that owns created repos
          tokenSuffix: (github.token || '').slice(-4),
        }
      : { connected: false },
    slack: slack
      ? {
          connected: true,
          teamName: slack.teamName || null,
          // Host only. For most webhook providers the URL path IS the secret
          // (hooks.slack.com/services/T…/B…/<token>), so the full value belongs
          // with the tokens, not in a status payload any member can read.
          analyzerHost: hostOf(slack.analyzerUrl),
          analyzerConfigured: !!slack.analyzerUrl,
          tokenSuffix: (slack.botToken || '').slice(-4),
        }
      : { connected: false },
    // `connected: false` here means "using the platform key", not an error.
    gemini: gemini
      ? { connected: true, keySuffix: (gemini.apiKey || '').slice(-4) }
      : { connected: false },
  };
}
