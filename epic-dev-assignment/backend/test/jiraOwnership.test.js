import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Guard: only the assignee may move a Jira ticket. Exercises the REAL middleware
// with Clerk and the Jira client stubbed, so a regression in the decision — not
// just in a restatement of it — fails the build.

const ALICE = 'acct_alice';
const BOB = 'acct_bob';

const ISSUES = {
  'TP1-1': { accountId: ALICE, name: 'Alice' },
  'TP1-2': { accountId: BOB, name: 'Bob' },
  'TP1-3': { accountId: null, name: null },   // unassigned
};

// Whose email Clerk reports for a given user id, and what Jira says that maps to.
let clerkEmail = 'alice@acme.com';
const JIRA_ACCOUNTS = { 'alice@acme.com': ALICE, 'bob@acme.com': BOB };

mock.module('@clerk/express', {
  namedExports: {
    clerkClient: {
      users: {
        getUser: async () => ({
          primaryEmailAddressId: 'idp',
          emailAddresses: clerkEmail ? [{ id: 'idp', emailAddress: clerkEmail }] : [],
        }),
      },
    },
  },
});

mock.module('../services/jiraClientFor.js', {
  namedExports: {
    jiraClientFor: async () => ({
      getIssueAssignee: async (key) => ISSUES[key] || { accountId: null, name: null },
      searchUser: async (q) => (JIRA_ACCOUNTS[q] ? [{ accountId: JIRA_ACCOUNTS[q] }] : []),
    }),
  },
});

const { requireIssueAssignee, requireAssignableByCaller, invalidateCallerJira } =
  await import('../middleware/jiraOwnership.js');

let seq = 0;
function call(mw, issueKey, email = 'alice@acme.com') {
  clerkEmail = email;
  // Unique user id per call so the 10-minute identity cache never masks a case.
  const req = { orgId: 'org_acme', userId: `user_${seq++}`, params: { issueKey } };
  return new Promise((resolve) => {
    const res = {
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, error: b.error }); },
    };
    mw(req, res, (err) => resolve(err ? { code: 'THROWN', error: err.message } : { code: 200 }));
  });
}

test('the assignee may move their own ticket', async () => {
  assert.deepEqual(await call(requireIssueAssignee, 'TP1-1'), { code: 200 });
});

test("a member may NOT move someone else's ticket", async () => {
  const r = await call(requireIssueAssignee, 'TP1-2');
  assert.equal(r.code, 403);
  assert.equal(r.error, 'NOT_ISSUE_ASSIGNEE');
});

test('nobody may move an unassigned ticket', async () => {
  const r = await call(requireIssueAssignee, 'TP1-3');
  assert.equal(r.code, 403);
  assert.equal(r.error, 'ISSUE_UNASSIGNED');
});

test('a caller with no Jira account may move nothing', async () => {
  const r = await call(requireIssueAssignee, 'TP1-1', 'stranger@acme.com');
  assert.equal(r.code, 403);
  assert.equal(r.error, 'JIRA_ACCOUNT_UNKNOWN');
});

test('a caller with no email at all may move nothing', async () => {
  const r = await call(requireIssueAssignee, 'TP1-1', null);
  assert.equal(r.code, 403);
  assert.equal(r.error, 'JIRA_ACCOUNT_UNKNOWN');
});

// Reassignment is guarded for the same reason: if it were open, anyone could
// assign a ticket to themselves and then move it.
test('an unassigned ticket may be claimed by anyone', async () => {
  assert.deepEqual(await call(requireAssignableByCaller, 'TP1-3'), { code: 200 });
});

test('you may hand off a ticket that is yours', async () => {
  assert.deepEqual(await call(requireAssignableByCaller, 'TP1-1'), { code: 200 });
});

test("you may NOT take someone else's ticket — the move rule cannot be sidestepped", async () => {
  const r = await call(requireAssignableByCaller, 'TP1-2');
  assert.equal(r.code, 403);
  assert.equal(r.error, 'NOT_ISSUE_ASSIGNEE');
});

test('Bob can move his own ticket but not Alice\'s', async () => {
  assert.deepEqual(await call(requireIssueAssignee, 'TP1-2', 'bob@acme.com'), { code: 200 });
  const r = await call(requireIssueAssignee, 'TP1-1', 'bob@acme.com');
  assert.equal(r.error, 'NOT_ISSUE_ASSIGNEE');
});

test('invalidateCallerJira is exported so an identity change is not cached for 10 min', () => {
  assert.equal(typeof invalidateCallerJira, 'function');
});
