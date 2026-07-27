import { getAuth } from '@clerk/express';
import { timingSafeEqual } from 'node:crypto';

// ─── Clerk org enforcement ───────────────────────────────────────────────────
// Every business route requires BOTH a signed-in user and an active organization.
// All data is org-scoped (B2B model) — a session without an org has nothing to see.
export function requireOrg(req, res, next) {
  const { userId, orgId, orgRole } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'UNAUTHENTICATED' });
  }
  if (!orgId) {
    return res.status(403).json({ success: false, error: 'NO_ACTIVE_ORG' });
  }
  req.userId = userId;
  req.orgId = orgId;
  req.orgRole = orgRole;
  return next();
}

// Admin-only gate for org-management actions (e.g. connecting integrations).
// Runs AFTER requireOrg (the /api gate), so req.orgRole is already populated.
export function requireOrgAdmin(req, res, next) {
  if (req.orgRole !== 'org:admin') {
    return res.status(403).json({ success: false, error: 'ORG_ADMIN_REQUIRED' });
  }
  return next();
}

// ─── Internal service lane (standup bot → Express) ──────────────────────────
// The bot is a trusted server-side caller with no Clerk session. It authenticates
// with the shared INTERNAL_API_KEY and declares which org it writes into via
// X-Org-Id (its per-deployment binding, see STANDUP_ORG_ID in the bot's env).
// Constant-time comparison: `===` on secrets returns as soon as bytes differ, so
// response timing leaks how much of a guessed key was correct. Lengths are
// compared first because timingSafeEqual throws on a length mismatch, and length
// alone is not the secret.
function keyMatches(configured, provided) {
  if (!configured || provided.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

function validInternalKey(req) {
  return keyMatches(process.env.INTERNAL_API_KEY || '', req.get('X-Internal-Key') || '');
}

// The credential lane (/api/internal/*) hands back DECRYPTED Jira and Slack
// secrets, so it gets its own key rather than reusing INTERNAL_API_KEY.
//
// Why: INTERNAL_API_KEY is deliberately the same value in three services, and one
// of them — epic-generator — only ever *verifies* it on inbound calls. With a
// single symmetric secret, holding the verifier is identical to holding the
// caller credential, so a file read in the smallest Flask app was enough to pull
// every pinned org's plaintext tokens out of the backend. Flask has no business
// calling this lane at all.
//
// INTERNAL_CREDENTIALS_KEY is checked first; if it is unset the lane falls back
// to INTERNAL_API_KEY so existing deployments keep working, and server.js logs a
// warning at boot. Set it on the backend and on the standup bot (and NOWHERE
// else) to close the gap.
function validCredentialsKey(req) {
  const provided = req.get('X-Internal-Key') || '';
  const dedicated = (process.env.INTERNAL_CREDENTIALS_KEY || '').trim();
  if (dedicated) return keyMatches(dedicated, provided);
  return keyMatches(process.env.INTERNAL_API_KEY || '', provided);
}

// The tenant the internal lane may act as. Per D6 the bot serves exactly ONE
// organization, so this is pinned by configuration and NEVER taken from the
// caller.
//
// This used to accept whatever X-Org-Id the caller sent, and treated an unset
// INTERNAL_ORG_ID as "allow any org" — which made the lane a decryption oracle
// for every tenant to anyone holding the shared key. It is now fail-closed:
// unset means the internal lane is disabled entirely, and the header can only
// ever agree with the pinned value, never widen it.
export function pinnedInternalOrg() {
  return (process.env.INTERNAL_ORG_ID || '').trim() || null;
}

// Resolves the org for an authenticated internal caller, or an error to send.
function resolveInternalOrg(req) {
  const pinned = pinnedInternalOrg();
  if (!pinned) {
    return {
      status: 503,
      error: 'INTERNAL_LANE_DISABLED',
      hint: 'Set INTERNAL_ORG_ID on the backend to the org the standup bot serves.',
    };
  }
  const claimed = req.get('X-Org-Id');
  if (claimed && claimed !== pinned) {
    return { status: 403, error: 'INTERNAL_ORG_NOT_ALLOWED' };
  }
  return { orgId: pinned };
}

export function orgOrInternal(req, res, next) {
  if (validInternalKey(req)) {
    const resolved = resolveInternalOrg(req);
    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, ...resolved });
    }
    req.internal = true;
    req.orgId = resolved.orgId; // pinned, not caller-supplied
    return next();
  }
  return requireOrg(req, res, next);
}

// Internal lane ONLY — no Clerk fallback. For routes that hand decrypted
// credentials to a trusted server-side service (the bot fetching its Slack
// config). A signed-in user, org admin or not, must never reach these.
export function requireInternal(req, res, next) {
  if (!validCredentialsKey(req)) {
    // Distinct from requireOrg's UNAUTHENTICATED on purpose: an identical body
    // for both makes it impossible to tell whether a caller failed the internal
    // key check or simply had no Clerk session, which is exactly the ambiguity
    // that made the earlier INTERNAL_API_KEY mismatch so slow to diagnose.
    return res.status(401).json({ success: false, error: 'INTERNAL_AUTH_REQUIRED' });
  }
  const resolved = resolveInternalOrg(req);
  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, ...resolved });
  }
  req.internal = true;
  req.orgId = resolved.orgId;
  return next();
}
