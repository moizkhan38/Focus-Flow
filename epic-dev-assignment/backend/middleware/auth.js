import { getAuth } from '@clerk/express';

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
function validInternalKey(req) {
  const configured = process.env.INTERNAL_API_KEY || '';
  return configured && req.get('X-Internal-Key') === configured;
}

// The internal key is shared with the Flask service and the standup bot, and the
// caller names its own tenant via X-Org-Id. That means a compromise of ANY of
// those services — or a leak of the key from any of their environments — would
// otherwise let the holder enumerate X-Org-Id and pull every tenant's decrypted
// Jira and Slack credentials.
//
// Per D6 the bot serves exactly one organization, so the blast radius can be
// pinned to that one. Set INTERNAL_ORG_ID on the backend to the same value as the
// bot's STANDUP_ORG_ID. Left unset, behaviour is unchanged (any org id accepted),
// so this is opt-in hardening rather than a breaking change.
function internalOrgAllowed(orgId) {
  const pinned = (process.env.INTERNAL_ORG_ID || '').trim();
  if (!pinned) return true;
  return orgId === pinned;
}

export function orgOrInternal(req, res, next) {
  if (validInternalKey(req)) {
    const orgId = req.get('X-Org-Id') || null; // may be null until the bot is bound (1.6 scoping tolerates it)
    if (!internalOrgAllowed(orgId)) {
      return res.status(403).json({ success: false, error: 'INTERNAL_ORG_NOT_ALLOWED' });
    }
    req.internal = true;
    req.orgId = orgId;
    return next();
  }
  return requireOrg(req, res, next);
}

// Internal lane ONLY — no Clerk fallback. For routes that hand decrypted
// credentials to a trusted server-side service (the bot fetching its Slack
// config). A signed-in user, org admin or not, must never reach these.
export function requireInternal(req, res, next) {
  if (!validInternalKey(req)) {
    // Distinct from requireOrg's UNAUTHENTICATED on purpose: an identical body
    // for both makes it impossible to tell whether a caller failed the internal
    // key check or simply had no Clerk session, which is exactly the ambiguity
    // that made the earlier INTERNAL_API_KEY mismatch so slow to diagnose.
    return res.status(401).json({ success: false, error: 'INTERNAL_AUTH_REQUIRED' });
  }
  const orgId = req.get('X-Org-Id') || null;
  if (!internalOrgAllowed(orgId)) {
    return res.status(403).json({ success: false, error: 'INTERNAL_ORG_NOT_ALLOWED' });
  }
  req.internal = true;
  req.orgId = orgId;
  return next();
}
