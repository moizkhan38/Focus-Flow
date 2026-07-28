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

// Accepted spellings for each feature.
//
// Clerk generates a feature's KEY from the NAME an operator types, so a plan
// built with readable labels produces "Jira Synchronization" -> jira_synchronization
// and "Unlimited project" -> unlimited_project. Those look right in the dashboard
// and match nothing, and the failure is silent: the customer pays and is refused.
//
// Insisting on one exact string pushes that whole class of mistake onto whoever
// configures the plan, where it is invisible until someone complains. Accepting a
// small, explicit set of variants per feature costs nothing and removes it. The
// FIRST entry is canonical and is what the docs tell people to use.
const FEATURE_ALIASES = {
  [/* jira_sync */ 'jira_sync']: [
    'jira_sync', 'jira_synchronization', 'jira_sync_and_boards', 'jira_integration',
  ],
  standup_bot: [
    'standup_bot', 'slack_standup_bot', 'standup_bot_slack', 'slack_bot',
  ],
  unlimited_projects: [
    'unlimited_projects', 'unlimited_project',
  ],
  unlimited_ai: [
    'unlimited_ai', 'unlimited_ai_generation', 'unlimited_ai_generations',
  ],
};

function featureMatches(feature, held) {
  const accepted = FEATURE_ALIASES[feature] || [feature];
  return accepted.some((a) => held.has(a));
}

// Numeric allowances that DIFFER per tier (Basic 10 members, Pro 25) can't be
// expressed as booleans, and Clerk features are booleans.
//
// Rather than mapping plan keys to numbers in code — which would make the plan
// key load-bearing, the exact coupling every other gate here avoids — the number
// is carried in the slug: `members_10`, `members_25`, `members_unlimited`. The
// highest one an org holds wins, so a plan may carry several without harm, and
// adding a `members_100` tier is dashboard-only with no deploy.
// Same tolerance for the member cap. Clerk turns "25 Members allowed" into
// 25_members_allowed, so the number can land on either side of the word.
const MEMBERS_SLUG_RES = [
  /^members_(\d+)$/,           // canonical: members_25
  /^(\d+)_members(?:_allowed)?$/, // from a label: 25_members_allowed, 25_members
  /^members?_(\d+)_allowed$/,  // member_25_allowed
];
const MEMBERS_UNLIMITED = ['members_unlimited', 'unlimited_members'];

function memberLimitFrom(features) {
  if (MEMBERS_UNLIMITED.some((s) => features.has(s))) return null; // null = unlimited
  let limit = FREE_LIMITS.developers;
  for (const f of features) {
    for (const re of MEMBERS_SLUG_RES) {
      const m = re.exec(f);
      if (m) limit = Math.max(limit, Number(m[1]));
    }
  }
  return limit;
}

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

  warnIfNoSlugRecognised(orgId, plan, features);

  const entitlement = { at: Date.now(), plan, features };
  entitlementCache.set(orgId, entitlement);
  return entitlement;
}

// Misspelled feature slugs fail CLOSED — the customer pays and receives nothing,
// which is the worst way for this to be wrong and the hardest to notice, because
// the app behaves like a perfectly ordinary free account.
//
// Clerk generates a feature's key from its NAME, so a plan built with readable
// labels produces keys like `slack_standup_bot` or `25_team_members` that look
// right and match nothing. Holding features while recognising none of them is the
// signature of exactly that, so say so loudly rather than silently downgrading.
// A slug the code can act on — canonical or any accepted variant. The warning
// below must use the same tolerance as the gates, or it cries wolf on a plan
// that is in fact working.
function isKnownSlug(slug) {
  if (Object.values(FEATURE_ALIASES).some((list) => list.includes(slug))) return true;
  if (MEMBERS_UNLIMITED.includes(slug)) return true;
  return MEMBERS_SLUG_RES.some((re) => re.test(slug));
}

// A free plan legitimately carries descriptive-only features — "2 projects
// allowed", "5 team members allowed" — purely so the Free column of
// <PricingTable /> reads well. Those match nothing by design, so warning about
// them would fire on every request for every free org and train the reader to
// ignore the one warning that matters.
const FREE_PLAN_RE = /free/i;

const warnedOrgs = new Set();

function warnIfNoSlugRecognised(orgId, plan, features) {
  if (features.size === 0) return;                       // nothing to match
  if (FREE_PLAN_RE.test(plan || '')) return;             // marketing copy on a free plan
  if ([...features].some(isKnownSlug)) return;
  if (warnedOrgs.has(orgId)) return;                     // once per process, not per request
  warnedOrgs.add(orgId);
  logger.warn(
    { orgId, plan, features: [...features] },
    '[Billing] This org is on a paid plan but NONE of its features match a known ' +
    'slug, so it is being treated as free — the customer is paying for nothing. ' +
    'Fix the feature KEYS on this plan in the Clerk dashboard: they must be exactly ' +
    'jira_sync, standup_bot, unlimited_projects, unlimited_ai, members_<n>. Clerk ' +
    'derives a feature key from its NAME, so a label like "Slack standup bot" ' +
    'yields slack_standup_bot, which matches nothing.'
  );
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
  return featureMatches(feature, features);
}

export async function currentPlan(req) {
  const { plan } = await resolveEntitlement(req);
  return plan || 'free';
}

// How many developers this org may hold. null = unlimited.
// Separate from UNLIMITED_PROJECTS, which now governs projects only: the two
// used to share a feature, which stops working the moment members are tiered
// (10 on Basic, 25 on Pro) while projects stay unlimited on both.
export async function memberLimit(req) {
  const { features } = await resolveEntitlement(req);
  return memberLimitFrom(features);
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
  const [plan, jiraSync, standupBot, unlimitedProjects, unlimitedAi, members] = await Promise.all([
    currentPlan(req),
    hasFeature(req, FEATURES.JIRA_SYNC),
    hasFeature(req, FEATURES.STANDUP_BOT),
    hasFeature(req, FEATURES.UNLIMITED_PROJECTS),
    hasFeature(req, FEATURES.UNLIMITED_AI),
    memberLimit(req),
  ]);

  const [projects, developers, aiUsed] = await Promise.all([
    countProjects(orgId),
    countDevelopers(orgId),
    getUsage(orgId, METRICS.AI_GENERATIONS),
  ]);

  return {
    plan,
    // Derived from FEATURES, not from the plan's key.
    //
    // Clerk enforces a $1 minimum on plans, so a literal $0 "free" plan cannot
    // exist — the free tier is simply "no subscription". That makes the plan key
    // arbitrary: a paid plan might be keyed anything at all. Reading paid-ness
    // off the key would mislabel a real customer the moment someone renamed a
    // plan in the dashboard, which is exactly the coupling the rest of this file
    // avoids by gating on features.
    isPaid: [
      jiraSync, standupBot, unlimitedProjects, unlimitedAi,
      members === null || members > FREE_LIMITS.developers,
    ].some(Boolean),
    features: {
      [FEATURES.JIRA_SYNC]: jiraSync,
      [FEATURES.STANDUP_BOT]: standupBot,
      [FEATURES.UNLIMITED_PROJECTS]: unlimitedProjects,
      [FEATURES.UNLIMITED_AI]: unlimitedAi,
    },
    usage: {
      projects: { used: projects, limit: unlimitedProjects ? null : FREE_LIMITS.projects },
      // Tiered by plan (free 5, Basic 10, Pro 25) via the members_<n> slugs.
      developers: { used: developers, limit: members },
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
