import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The paywall must be enforced on the SERVER. Hiding a button in React stops
// nobody: every gated route is one fetch() away. These exercise the real
// middleware with the database and Clerk stubbed.

let projectCount = 0;
let developerCount = 0;
let aiUsed = 0;
let existingProjectIds = new Set();
let existingDevelopers = new Set();

mock.module('../db.js', {
  namedExports: {
    query: async (sql, params) => {
      if (/FROM org_usage/.test(sql)) return { rows: aiUsed ? [{ used: aiUsed }] : [] };
      if (/COUNT\(\*\)::int AS n FROM projects/.test(sql)) return { rows: [{ n: projectCount }] };
      if (/COUNT\(\*\)::int AS n FROM developers/.test(sql)) return { rows: [{ n: developerCount }] };
      if (/SELECT 1 FROM projects/.test(sql)) {
        return { rows: existingProjectIds.has(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT 1 FROM developers/.test(sql)) {
        return { rows: existingDevelopers.has(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
    pool: {},
  },
});

mock.module('@clerk/express', {
  namedExports: {
    clerkClient: {
      billing: {
        // Simulates an instance where billing is not configured — the code must
        // fall back to the free tier rather than throwing or granting access.
        getOrganizationBillingSubscription: async () => { throw new Error('Forbidden'); },
      },
    },
  },
});

const billing = await import('../services/billing.js');
const {
  requireFeature, requireAiQuota, requireProjectQuota, requireDeveloperQuota,
} = await import('../middleware/requirePlan.js');

let orgSeq = 0;
function reqFor({ paid = false, body = {} } = {}) {
  // Fresh org id per call so the 60s entitlement cache never leaks between tests.
  const orgId = `org_${orgSeq++}`;
  const claims = paid
    ? { pla: 'org:pro', fea: 'org:jira_sync,org:standup_bot,org:unlimited_projects,org:unlimited_ai' }
    : {};
  return { orgId, body, auth: { sessionClaims: claims } };
}

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, ...b }); },
    };
    mw(req, res, (err) => resolve(err ? { code: 'THROWN', error: err.message } : { code: 200 }));
  });
}

test.beforeEach(() => {
  projectCount = 0; developerCount = 0; aiUsed = 0;
  existingProjectIds = new Set(); existingDevelopers = new Set();
});

// ─── feature gates ──────────────────────────────────────────────────────────

test('a free org is refused a paid feature with 402 UPGRADE_REQUIRED', async () => {
  const r = await run(requireFeature(billing.FEATURES.JIRA_SYNC, 'Jira sync is paid.'), reqFor());
  assert.equal(r.code, 402);
  assert.equal(r.error, 'UPGRADE_REQUIRED');
  assert.equal(r.feature, 'jira_sync');
  assert.equal(r.message, 'Jira sync is paid.');
});

test('a paid org passes the same gate', async () => {
  const r = await run(requireFeature(billing.FEATURES.JIRA_SYNC), reqFor({ paid: true }));
  assert.equal(r.code, 200);
});

test('402 is distinct from 403 and 412 so the UI can route correctly', async () => {
  const r = await run(requireFeature(billing.FEATURES.STANDUP_BOT), reqFor());
  assert.equal(r.code, 402, 'must not collapse into 403 (role) or 412 (not connected)');
});

// ─── AI quota ───────────────────────────────────────────────────────────────

test('AI generation is allowed below the free allowance', async () => {
  aiUsed = billing.FREE_LIMITS.aiGenerationsPerMonth - 1;
  assert.equal((await run(requireAiQuota, reqFor())).code, 200);
});

test('AI generation is refused at the free allowance', async () => {
  aiUsed = billing.FREE_LIMITS.aiGenerationsPerMonth;
  const r = await run(requireAiQuota, reqFor());
  assert.equal(r.code, 402);
  assert.equal(r.feature, 'unlimited_ai');
  assert.equal(r.limit, billing.FREE_LIMITS.aiGenerationsPerMonth);
  assert.equal(r.used, billing.FREE_LIMITS.aiGenerationsPerMonth);
});

test('a paid org is never stopped by the AI allowance', async () => {
  aiUsed = 10_000;
  assert.equal((await run(requireAiQuota, reqFor({ paid: true }))).code, 200);
});

// ─── project quota ──────────────────────────────────────────────────────────

test('a free org may create up to its project limit', async () => {
  projectCount = billing.FREE_LIMITS.projects - 1;
  assert.equal((await run(requireProjectQuota, reqFor())).code, 200);
});

test('a free org is refused the project over its limit', async () => {
  projectCount = billing.FREE_LIMITS.projects;
  const r = await run(requireProjectQuota, reqFor());
  assert.equal(r.code, 402);
  assert.equal(r.feature, 'unlimited_projects');
});

test('an at-limit free org can still EDIT the projects it already owns', async () => {
  // /db/projects is an upsert. Charging quota on every save would make a free org
  // unable to touch the projects its plan entitles it to keep.
  projectCount = billing.FREE_LIMITS.projects;
  existingProjectIds.add('proj-existing');
  const r = await run(requireProjectQuota, reqFor({ body: { id: 'proj-existing' } }));
  assert.equal(r.code, 200);
});

test('an at-limit free org still cannot create a NEW project by sending an id', async () => {
  projectCount = billing.FREE_LIMITS.projects;
  const r = await run(requireProjectQuota, reqFor({ body: { id: 'proj-not-mine' } }));
  assert.equal(r.code, 402);
});

// ─── developer quota ────────────────────────────────────────────────────────

test('a free org is refused the team member over its limit', async () => {
  developerCount = billing.FREE_LIMITS.developers;
  const r = await run(requireDeveloperQuota, reqFor({ body: { username: 'newdev' } }));
  assert.equal(r.code, 402);
  assert.equal(r.limit, billing.FREE_LIMITS.developers);
});

// Member caps are TIERED, so they are carried as members_<n> feature slugs
// rather than a boolean. The number in the slug is the cap; highest one wins.
function withFeatures(fea) {
  return { orgId: `org_m_${orgSeq++}`, body: { username: 'newdev' }, auth: { sessionClaims: { fea } } };
}

test('Basic (members_10) allows 10 team members and refuses the 11th', async () => {
  developerCount = 9;
  assert.equal((await run(requireDeveloperQuota, withFeatures('o:members_10'))).code, 200);
  developerCount = 10;
  const r = await run(requireDeveloperQuota, withFeatures('o:members_10'));
  assert.equal(r.code, 402);
  assert.equal(r.limit, 10);
  assert.equal(r.used, 10);
});

test('Pro (members_25) allows 25 team members and refuses the 26th', async () => {
  developerCount = 24;
  assert.equal((await run(requireDeveloperQuota, withFeatures('o:members_25'))).code, 200);
  developerCount = 25;
  const r = await run(requireDeveloperQuota, withFeatures('o:members_25'));
  assert.equal(r.code, 402);
  assert.equal(r.limit, 25);
});

test('the highest members_<n> wins when a plan carries several', async () => {
  developerCount = 20;
  const r = await run(requireDeveloperQuota, withFeatures('o:members_10,o:members_25'));
  assert.equal(r.code, 200, 'must not be capped at the lower slug');
});

test('members_unlimited removes the cap entirely', async () => {
  developerCount = 5000;
  assert.equal((await run(requireDeveloperQuota, withFeatures('o:members_unlimited'))).code, 200);
});

test('a members_<n> slug never lowers the cap below the free allowance', async () => {
  // A misconfigured members_1 must not leave a paying org worse off than free.
  developerCount = billing.FREE_LIMITS.developers - 1;
  assert.equal((await run(requireDeveloperQuota, withFeatures('o:members_1'))).code, 200);
});

test('unlimited_projects no longer silently lifts the member cap', async () => {
  // The two shared a feature before members were tiered. If they still shared it,
  // Basic would get unlimited members instead of 10.
  developerCount = billing.FREE_LIMITS.developers;
  const r = await run(requireDeveloperQuota, withFeatures('o:unlimited_projects'));
  assert.equal(r.code, 402);
  assert.equal(r.limit, billing.FREE_LIMITS.developers);
});

test('member allowance is reported in billing status', async () => {
  developerCount = 3;
  const basic = { orgId: 'org_status_basic', auth: { sessionClaims: { fea: 'o:members_10,o:unlimited_ai' } } };
  const status = await billing.billingStatus(basic);
  assert.equal(status.usage.developers.limit, 10);
  assert.equal(status.isPaid, true, 'a raised member cap alone counts as paid');
});

test('an at-limit free org can still update an existing team member', async () => {
  developerCount = billing.FREE_LIMITS.developers;
  existingDevelopers.add('olddev');
  const r = await run(requireDeveloperQuota, reqFor({ body: { username: 'olddev' } }));
  assert.equal(r.code, 200);
});

// ─── failure mode ───────────────────────────────────────────────────────────

test('a billing outage degrades to the free tier, not to open access', async () => {
  // The stubbed Clerk client always throws. A free org must still be refused paid
  // features (not granted them), and the app must keep working otherwise.
  const r = await run(requireFeature(billing.FEATURES.JIRA_SYNC), reqFor());
  assert.equal(r.code, 402, 'a billing failure must never grant a paid feature');
  assert.equal((await run(requireAiQuota, reqFor())).code, 200, 'free-tier work must keep functioning');
});

test('entitlement is read from scope-prefixed Clerk claims', async () => {
  // Clerk's `fea` claim scope-prefixes each slug ("o:" for org, "u:" for user).
  // The code must strip that, or every gate silently fails closed for paying
  // customers — the worst failure mode: they paid and got nothing.
  const req = { orgId: 'org_claims_a', auth: { sessionClaims: { fea: ['o:jira_sync'] } } };
  assert.equal(await billing.hasFeature(req, 'jira_sync'), true);
  assert.equal(await billing.hasFeature(req, 'standup_bot'), false);
});

test('bare (unprefixed) feature claims also resolve', async () => {
  const req = { orgId: 'org_claims_b', auth: { sessionClaims: { fea: 'standup_bot,unlimited_ai' } } };
  assert.equal(await billing.hasFeature(req, 'standup_bot'), true);
  assert.equal(await billing.hasFeature(req, 'unlimited_ai'), true);
  assert.equal(await billing.hasFeature(req, 'jira_sync'), false);
});

test('paid-ness is derived from features, not from the plan key', async () => {
  // Clerk enforces a $1 minimum, so there is no $0 plan and the free tier is
  // "no subscription". A paid plan may therefore be keyed anything — including
  // "free", if that is the plan someone repurposed. Entitlement must follow the
  // features, or a paying customer gets free-tier limits.
  const paidButKeyedFree = {
    orgId: 'org_keyed_free',
    auth: { sessionClaims: { pla: 'o:free', fea: 'o:jira_sync,o:standup_bot,o:unlimited_projects,o:unlimited_ai' } },
  };
  const status = await billing.billingStatus(paidButKeyedFree);
  assert.equal(status.plan, 'free', 'the key is reported as-is');
  assert.equal(status.isPaid, true, 'but paid-ness comes from the features');
  assert.equal(status.usage.projects.limit, null, 'so no free-tier cap applies');
  assert.equal(status.usage.aiGenerations.limit, null);

  // And the gates agree.
  assert.equal((await run(requireFeature(billing.FEATURES.JIRA_SYNC), paidButKeyedFree)).code, 200);
  assert.equal((await run(requireProjectQuota, paidButKeyedFree)).code, 200);
});

test('a mid-tier plan gets exactly its own features, not a cumulative ladder', async () => {
  // Basic carries unlimited_ai + unlimited_projects but NOT the integrations.
  // Entitlement is the feature set of the subscribed plan, so a Basic org must
  // lose its caps while still being refused Jira sync and the standup bot.
  const basic = {
    orgId: 'org_basic',
    auth: { sessionClaims: { pla: 'o:basic', fea: 'o:unlimited_ai,o:unlimited_projects' } },
  };
  const status = await billing.billingStatus(basic);
  assert.equal(status.isPaid, true);
  assert.equal(status.usage.projects.limit, null, 'caps lifted');
  assert.equal(status.usage.aiGenerations.limit, null);
  assert.equal(status.features.jira_sync, false, 'integrations still gated');
  assert.equal(status.features.standup_bot, false);

  assert.equal((await run(requireAiQuota, basic)).code, 200);
  assert.equal((await run(requireProjectQuota, basic)).code, 200);
  assert.equal((await run(requireFeature(billing.FEATURES.JIRA_SYNC), basic)).code, 402);
  assert.equal((await run(requireFeature(billing.FEATURES.STANDUP_BOT), basic)).code, 402);
});

test('descriptive-only features on the Free plan grant nothing', async () => {
  // A free plan legitimately carries labels like "2 projects allowed" purely so
  // the Free column of <PricingTable /> reads well. They must never be mistaken
  // for entitlement — note "5 team members allowed" must NOT satisfy members_<n>.
  developerCount = 1;
  const req = {
    orgId: 'org_free_labels',
    auth: { sessionClaims: {
      pla: 'o:free_org',
      fea: 'o:2_projects_allowed,o:liimited_ai_quota,o:5_team_members_allowed',
    } },
  };
  const status = await billing.billingStatus(req);
  assert.equal(status.isPaid, false);
  assert.equal(status.usage.projects.limit, billing.FREE_LIMITS.projects);
  assert.equal(status.usage.developers.limit, billing.FREE_LIMITS.developers);
  assert.equal(status.usage.aiGenerations.limit, billing.FREE_LIMITS.aiGenerationsPerMonth);
  assert.equal((await run(requireFeature(billing.FEATURES.JIRA_SYNC), req)).code, 402);
});

test('a members-like LABEL does not satisfy the members_<n> cap', async () => {
  // "5 team members allowed" -> 5_team_members_allowed. The slug regex is
  // anchored precisely so a descriptive key cannot be read as an allowance.
  developerCount = billing.FREE_LIMITS.developers;
  const req = {
    orgId: 'org_label_members',
    body: { username: 'newdev' },
    auth: { sessionClaims: { fea: 'o:25_team_members,o:team_members_25' } },
  };
  const r = await run(requireDeveloperQuota, req);
  assert.equal(r.code, 402);
  assert.equal(r.limit, billing.FREE_LIMITS.developers, 'must not read 25 out of a label');
});

test('an org SUBSCRIBED to Clerk\'s empty Free plan gets the free tier', async () => {
  // Clerk creates a default Free plan carrying no features. That is a different
  // state from "no subscription" — the token says pla: free — and both must land
  // on the same allowances, or whichever one the dashboard produces would be wrong.
  developerCount = 2;
  const onFreePlan = { orgId: 'org_on_free', auth: { sessionClaims: { pla: 'o:free', fea: '' } } };
  const status = await billing.billingStatus(onFreePlan);

  assert.equal(status.plan, 'free');
  assert.equal(status.isPaid, false);
  assert.equal(status.usage.projects.limit, billing.FREE_LIMITS.projects);
  assert.equal(status.usage.developers.limit, billing.FREE_LIMITS.developers);
  assert.equal(status.usage.aiGenerations.limit, billing.FREE_LIMITS.aiGenerationsPerMonth);
  assert.equal(status.features.jira_sync, false);
  assert.equal(status.features.standup_bot, false);

  // And the gates agree.
  assert.equal((await run(requireFeature(billing.FEATURES.JIRA_SYNC), onFreePlan)).code, 402);
  developerCount = billing.FREE_LIMITS.developers;
  assert.equal((await run(requireDeveloperQuota, { ...onFreePlan, body: { username: 'new' } })).code, 402);
});

test('an unsubscribed org gets the free tier without any "free" plan existing', async () => {
  const status = await billing.billingStatus(reqFor());
  assert.equal(status.isPaid, false);
  assert.equal(status.usage.projects.limit, billing.FREE_LIMITS.projects);
  assert.equal(status.usage.aiGenerations.limit, billing.FREE_LIMITS.aiGenerationsPerMonth);
});

// Clerk derives a feature's key from the NAME an operator types, so plans built
// with readable labels produce keys that look right and match nothing. These are
// the exact slugs a real Pro plan produced.
test('label-derived feature keys still grant their feature', async () => {
  const pro = {
    orgId: 'org_label_derived',
    auth: { sessionClaims: { pla: 'o:pro', fea:
      'o:unlimited_project,o:jira_synchronization,o:standup_bot,o:25_members_allowed,o:unlimited_ai' } },
  };
  const status = await billing.billingStatus(pro);
  assert.equal(status.isPaid, true);
  assert.equal(status.features.jira_sync, true, 'jira_synchronization must grant jira_sync');
  assert.equal(status.features.standup_bot, true);
  assert.equal(status.features.unlimited_projects, true, 'unlimited_project (no s) must count');
  assert.equal(status.features.unlimited_ai, true);
  assert.equal(status.usage.developers.limit, 25, '25_members_allowed must set the cap');
  assert.equal(status.usage.projects.limit, null);

  assert.equal((await run(requireFeature(billing.FEATURES.JIRA_SYNC), pro)).code, 200);
  assert.equal((await run(requireFeature(billing.FEATURES.STANDUP_BOT), pro)).code, 200);
});

test('member cap is read whichever side of the word the number falls', async () => {
  for (const [slug, expected] of [
    ['members_25', 25], ['25_members_allowed', 25], ['25_members', 25], ['member_25_allowed', 25],
  ]) {
    developerCount = 24;
    const req = { orgId: `org_m_${slug}`, body: { username: 'newdev' },
                  auth: { sessionClaims: { fea: `o:${slug}` } } };
    assert.equal((await run(requireDeveloperQuota, req)).code, 200, `${slug} should allow 24`);
    developerCount = expected;
    const req2 = { orgId: `org_m2_${slug}`, body: { username: 'newdev' },
                   auth: { sessionClaims: { fea: `o:${slug}` } } };
    const r = await run(requireDeveloperQuota, req2);
    assert.equal(r.limit, expected, `${slug} should cap at ${expected}`);
  }
});

test('an unrelated feature slug still grants nothing', async () => {
  // Tolerance must not become "match anything vaguely similar".
  const req = { orgId: 'org_unrelated',
                auth: { sessionClaims: { fea: 'o:jira,o:sync,o:premium_plan,o:everything' } } };
  assert.equal(await billing.hasFeature(req, 'jira_sync'), false);
  assert.equal(await billing.hasFeature(req, 'standup_bot'), false);
});

test('has() is called with the BARE slug, never namespaced with org:', async () => {
  // Clerk reserves "org:" for custom permissions. Passing "org:jira_sync" to
  // has({ feature }) never matches, so a paying org would be refused.
  const seen = [];
  const req = {
    orgId: 'org_has',
    auth: {
      sessionClaims: {},
      has: (params) => { seen.push(params); return params.feature === 'jira_sync'; },
    },
  };
  assert.equal(await billing.hasFeature(req, 'jira_sync'), true);
  assert.deepEqual(seen, [{ feature: 'jira_sync' }]);
});
