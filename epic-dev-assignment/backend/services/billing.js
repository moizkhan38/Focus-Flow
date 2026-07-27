import { clerkClient } from '@clerk/express';
import { query } from '../db.js';
import { logger } from '../logger.js';

// Per-organization subscriptions (Clerk Billing).
//
// SPLIT OF RESPONSIBILITY
//   Clerk owns ENTITLEMENT — which plan an org bought and which features that
//   grants. It is the payment system's job and we never mirror it into our own
//   table, because a mirror is a thing that goes stale.
//   We own METERING — how much of a limited thing an org has used this month.
//   Clerk cannot know that. It lives in org_usage.
//
// WHY THIS IS CHECKED ON THE SERVER
//   The UI hides paid features, but hiding is not enforcing: every gated route
//   is one fetch() away from an unsubscribed org. These guards are the actual
//   paywall; the UI is only there so nobody has to discover it by being refused.

// Feature slugs, as configured in the Clerk dashboard. Gating is by FEATURE, not
// by plan name, so plans can be renamed, split or repriced without touching code.
export const FEATURES = {
  JIRA_SYNC: 'jira_sync',
  STANDUP_BOT: 'standup_bot',
  UNLIMITED_PROJECTS: 'unlimited_projects',
  UNLIMITED_AI: 'unlimited_ai',
};

// Metric keys for org_usage.
export const METRICS = { AI_GENERATIONS: 'ai_generations' };

// Free-tier allowances. Anything a paid feature makes unlimited is capped here
// instead. Overridable by env so the numbers can be tuned without a deploy.
export const FREE_LIMITS = {
  projects: Number(process.env.FREE_MAX_PROJECTS || 2),
  aiGenerationsPerMonth: Number(process.env.FREE_MAX_AI_GENERATIONS || 20),
  developers: Number(process.env.FREE_MAX_DEVELOPERS || 5),
};

// ─── entitlement ────────────────────────────────────────────────────────────

const ENTITLEMENT_TTL_MS = 60 * 1000;
const entitlementCache = new Map(); // orgId -> { at, plan, features:Set }

export function invalidateEntitlement(orgId) {
  entitlementCache.delete(orgId);
}

// Ask Clerk what this org is entitled to.
//
// Prefers the session claims already on the request (free — no network call).
// Falls back to the Billing API when the token carries no billing claims, which
// happens on older session-token versions and immediately after a checkout,
// before the client has refreshed its token. Without the fallback an org would
// pay and then still be refused for up to a minute.
async function resolveEntitlement(req) {
  const orgId = req.orgId;
  const hit = entitlementCache.get(orgId);
  if (hit && Date.now() - hit.at < ENTITLEMENT_TTL_MS) return hit;

  let plan = null;
  const features = new Set();

  // 1. Session claims.
  const claims = req.auth?.sessionClaims || req.sessionClaims;
  const claimedFeatures = claims?.fea ?? claims?.features;
  const claimedPlan = claims?.pla ?? claims?.plan;
  if (claimedFeatures || claimedPlan) {
    for (const f of parseClaimList(claimedFeatures)) features.add(f);
    plan = firstOf(parseClaimList(claimedPlan)) || null;
  }

  // 2. Billing API — authoritative, used when the token told us nothing.
  if (!plan && features.size === 0) {
    try {
      const sub = await clerkClient.billing.getOrganizationBillingSubscription(orgId);
      for (const item of sub?.subscriptionItems || []) {
        // Only entitlements that are actually live count. A past_due or cancelled
        // item must not keep paid features open.
        if (item.status && !['active', 'trialing'].includes(item.status)) continue;
        if (item.plan?.slug) plan = item.plan.slug;
        for (const f of item.plan?.features || []) {
          if (f?.slug) features.add(f.slug);
        }
      }
    } catch (err) {
      // A billing outage must not take the product down. Fail to the FREE tier:
      // the app keeps working, paid features are refused, nothing is given away.
      logger.warn({ err: err.message, orgId }, '[Billing] entitlement lookup failed — treating as free');
    }
  }

  const entitlement = { at: Date.now(), plan, features };
  entitlementCache.set(orgId, entitlement);
  return entitlement;
}

// Clerk encodes list claims as either an array or a comma-separated string, and
// features may be namespaced ("org:jira_sync"). Normalise both.
function parseClaimList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .map((v) => (v.includes(':') ? v.slice(v.indexOf(':') + 1) : v));
}

function firstOf(list) {
  return list.length ? list[0] : null;
}

export async function hasFeature(req, feature) {
  // req.auth.has() is the cheapest path when Clerk put billing in the token.
  //
  // The slug is passed BARE. Clerk's has() does not want the "org:" namespace —
  // that prefix belongs to custom permissions (org:teams:manage), not features.
  // Passing "org:jira_sync" here silently never matches, which fails closed and
  // would have refused paying customers their features.
  try {
    if (typeof req.auth?.has === 'function' && req.auth.has({ feature })) {
      return true;
    }
  } catch {
    // has() throws on token versions that don't carry billing claims — fall through.
  }
  const { features } = await resolveEntitlement(req);
  return features.has(feature);
}

export async function currentPlan(req) {
  const { plan } = await resolveEntitlement(req);
  return plan || 'free';
}

// ─── metering ───────────────────────────────────────────────────────────────

function periodStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export async function getUsage(orgId, metric) {
  const { rows } = await query(
    'SELECT used FROM org_usage WHERE org_id = $1 AND metric = $2 AND period = $3',
    [orgId, metric, periodStart()]
  );
  return rows[0]?.used || 0;
}

// Atomic increment. The upsert does the arithmetic in the database so two
// concurrent generations cannot both read 9 and both write 10.
export async function recordUsage(orgId, metric, amount = 1) {
  const { rows } = await query(
    `INSERT INTO org_usage (org_id, metric, period, used)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, metric, period)
     DO UPDATE SET used = org_usage.used + EXCLUDED.used
     RETURNING used`,
    [orgId, metric, periodStart(), amount]
  );
  return rows[0]?.used || 0;
}

export async function countProjects(orgId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM projects WHERE org_id = $1',
    [orgId]
  );
  return rows[0]?.n || 0;
}

export async function countDevelopers(orgId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM developers WHERE org_id = $1',
    [orgId]
  );
  return rows[0]?.n || 0;
}

// ─── the shape the UI renders ───────────────────────────────────────────────

export async function billingStatus(req) {
  const orgId = req.orgId;
  const [plan, jiraSync, standupBot, unlimitedProjects, unlimitedAi] = await Promise.all([
    currentPlan(req),
    hasFeature(req, FEATURES.JIRA_SYNC),
    hasFeature(req, FEATURES.STANDUP_BOT),
    hasFeature(req, FEATURES.UNLIMITED_PROJECTS),
    hasFeature(req, FEATURES.UNLIMITED_AI),
  ]);

  const [projects, developers, aiUsed] = await Promise.all([
    countProjects(orgId),
    countDevelopers(orgId),
    getUsage(orgId, METRICS.AI_GENERATIONS),
  ]);

  return {
    plan,
    isPaid: plan !== 'free',
    features: {
      [FEATURES.JIRA_SYNC]: jiraSync,
      [FEATURES.STANDUP_BOT]: standupBot,
      [FEATURES.UNLIMITED_PROJECTS]: unlimitedProjects,
      [FEATURES.UNLIMITED_AI]: unlimitedAi,
    },
    usage: {
      projects: { used: projects, limit: unlimitedProjects ? null : FREE_LIMITS.projects },
      developers: { used: developers, limit: unlimitedProjects ? null : FREE_LIMITS.developers },
      aiGenerations: {
        used: aiUsed,
        limit: unlimitedAi ? null : FREE_LIMITS.aiGenerationsPerMonth,
        resetsOn: nextPeriodStart(),
      },
    },
  };
}

function nextPeriodStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}
