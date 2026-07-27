import { clerkClient } from '@clerk/express';
import { jiraClientFor } from '../services/jiraClientFor.js';

// Assignee-only enforcement for Jira issue mutations.
//
// THE RULE: only the person a ticket is assigned to may move it. Not their
// teammates, not another member of the org — and an unassigned ticket may be
// moved by nobody, because there is no assignee to be.
//
// This matches what the standup bot has always enforced (move_jira_ticket in
// standup-bot/app.py). Previously the board did not: /api/jira/issue/:key
// transitioned whatever the caller named, so any org member could drag any
// card. Both paths now agree.
//
// REASSIGNMENT IS GUARDED TOO, and that is not incidental. If transitions were
// assignee-only but assignment stayed open, anyone could assign a ticket to
// themselves and then move it — the rule would be one extra click, not a rule.
// So: you may claim an UNASSIGNED ticket, and you may hand off a ticket that is
// currently yours. Taking someone else's ticket is refused.
//
// Identity chain: Clerk user -> their verified email -> Jira accountId. A member
// whose email matches no Jira account cannot move anything, which is the
// fail-closed direction.

const TTL_MS = 10 * 60 * 1000;

// `${orgId}:${userId}` -> { at, accountId, email }
const callerCache = new Map();

export function invalidateCallerJira(orgId, userId) {
  callerCache.delete(`${orgId}:${userId}`);
}

async function callerEmail(userId) {
  const user = await clerkClient.users.getUser(userId);
  const primaryId = user.primaryEmailAddressId;
  const addresses = user.emailAddresses || [];
  const primary = addresses.find((e) => e.id === primaryId) || addresses[0];
  return primary?.emailAddress || null;
}

// The calling user's Jira accountId, or null if they have no Jira account.
// Exported so the UI can ask "which cards are mine?" and disable dragging on the
// rest, rather than letting a member drag a card only to have it snap back.
export async function callerJiraAccountId(req) {
  const key = `${req.orgId}:${req.userId}`;
  const hit = callerCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.accountId;

  let email = null;
  try {
    email = await callerEmail(req.userId);
  } catch (err) {
    req.log?.warn(`[JiraOwnership] could not read Clerk email: ${err.message}`);
  }

  // No roster fallback on purpose: `developers` is keyed by GitHub username with
  // no link to a Clerk user, so matching through it would let one person's Jira
  // identity be claimed by another. The signed-in email is the only binding we
  // can actually trust here.
  let accountId = null;
  if (email) {
    try {
      const jira = await jiraClientFor(req.orgId);
      const users = await jira.searchUser(email);
      accountId = users[0]?.accountId || null;
    } catch (err) {
      req.log?.warn(`[JiraOwnership] Jira user lookup failed: ${err.message}`);
    }
  }

  callerCache.set(key, { at: Date.now(), accountId, email });
  return accountId;
}

function denyNoJiraAccount(res) {
  return res.status(403).json({
    success: false,
    error: 'JIRA_ACCOUNT_UNKNOWN',
    message:
      'We could not match your account to a Jira user, so we cannot confirm this ' +
      'ticket is yours. Ask an admin to invite your email address to Jira.',
  });
}

// PUT /api/jira/issue/:issueKey — transition. Assignee only.
export async function requireIssueAssignee(req, res, next) {
  try {
    const issueKey = req.params.issueKey;
    const me = await callerJiraAccountId(req);
    if (!me) return denyNoJiraAccount(res);

    const jira = await jiraClientFor(req.orgId);
    const assignee = await jira.getIssueAssignee(issueKey);

    if (!assignee.accountId) {
      return res.status(403).json({
        success: false,
        error: 'ISSUE_UNASSIGNED',
        message: `${issueKey} has no assignee, so nobody can move it. Assign it first.`,
      });
    }
    if (assignee.accountId !== me) {
      return res.status(403).json({
        success: false,
        error: 'NOT_ISSUE_ASSIGNEE',
        message: `${issueKey} is assigned to ${assignee.name}, so only they can move it.`,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// PUT /api/jira/issue/:issueKey/assign — claim if unassigned, or hand off your own.
export async function requireAssignableByCaller(req, res, next) {
  try {
    const issueKey = req.params.issueKey;
    const me = await callerJiraAccountId(req);
    if (!me) return denyNoJiraAccount(res);

    const jira = await jiraClientFor(req.orgId);
    const assignee = await jira.getIssueAssignee(issueKey);

    // Unassigned: anyone on the team may pick it up.
    if (!assignee.accountId) return next();
    // Yours: you may hand it on.
    if (assignee.accountId === me) return next();

    return res.status(403).json({
      success: false,
      error: 'NOT_ISSUE_ASSIGNEE',
      message:
        `${issueKey} is assigned to ${assignee.name}. Only they can reassign it — ` +
        'ask them to hand it over.',
    });
  } catch (err) {
    return next(err);
  }
}
