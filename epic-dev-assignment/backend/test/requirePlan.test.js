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

test('entitlement is read from namespaced Clerk claims', async () => {
  // Clerk emits "org:jira_sync"; the code must not require an exact-string match
  // on the bare slug or every gate silently fails closed for paying customers.
  const req = { orgId: 'org_claims', auth: { sessionClaims: { fea: ['org:jira_sync'] } } };
  assert.equal(await billing.hasFeature(req, 'jira_sync'), true);
  assert.equal(await billing.hasFeature(req, 'standup_bot'), false);
});
