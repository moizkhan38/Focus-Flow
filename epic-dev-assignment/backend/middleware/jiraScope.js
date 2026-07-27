import { query } from '../db.js';
import { jiraClientFor } from '../services/jiraClientFor.js';

// Ownership guard for /api/jira/*.
//
// THE PROBLEM. Every handler in routes/jira.js resolves its client with
// jiraClientFor(req.orgId) and then passes the caller's project key / board id /
// sprint id / issue key straight through. The /api gate only requires org
// MEMBERSHIP, and the connected credential is normally an Atlassian ADMIN token
// (project creation in sync.js needs one). So the backend acted with far more
// authority on the tenant's Jira site than the calling user has in Jira itself:
// a member could read HR-1, transition SEC-42, or reassign LEGAL-7 — issues Jira
// would have refused them directly — simply by naming the key. jiraService's
// /^[A-Z][A-Z0-9]{1,9}$/ whitelist stops JQL injection but permits any real key.
//
// THE RULE. A request may only touch Jira objects belonging to a project this
// org has recorded in the `projects` table. That is the set the product created
// or adopted; everything else on the customer's Atlassian site is out of scope.
//
// Cache is a hot-path optimisation only: a MISS always re-reads the table before
// denying, so a project synced seconds ago is never rejected as unknown.

const TTL_MS = 60_000;
const scopeCache = new Map();   // orgId -> { at, keys:Set<string>, boards:Set<string> }
const sprintBoard = new Map();  // `${orgId}:${sprintId}` -> { at, boardId }

async function loadScope(orgId) {
  const { rows } = await query(
    `SELECT jira_project_key, jira_board_id
       FROM projects
      WHERE org_id = $1
        AND (jira_project_key IS NOT NULL OR jira_board_id IS NOT NULL)`,
    [orgId]
  );
  const scope = {
    at: Date.now(),
    keys: new Set(rows.map((r) => (r.jira_project_key || '').toUpperCase()).filter(Boolean)),
    boards: new Set(rows.map((r) => r.jira_board_id).filter((v) => v !== null && v !== undefined).map(String)),
  };
  scopeCache.set(orgId, scope);
  return scope;
}

async function getScope(orgId) {
  const hit = scopeCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  return loadScope(orgId);
}

// Exported so a newly synced project is visible immediately.
export function invalidateJiraScope(orgId) {
  scopeCache.delete(orgId);
}

export async function orgJiraScope(orgId) {
  return getScope(orgId);
}

function deny(res) {
  // 404, not 403: whether a given key exists on the tenant's Jira site is itself
  // information the caller is not entitled to.
  return res.status(404).json({ success: false, error: 'PROJECT_NOT_FOUND' });
}

async function ownsProjectKey(orgId, rawKey) {
  const key = String(rawKey || '').toUpperCase();
  if (!key) return false;
  let scope = await getScope(orgId);
  if (scope.keys.has(key)) return true;
  if (Date.now() - scope.at < 1000) return false; // just loaded — a re-read cannot help
  scope = await loadScope(orgId);                 // miss: confirm against fresh state
  return scope.keys.has(key);
}

async function ownsBoard(orgId, rawId) {
  const id = String(rawId || '');
  if (!id) return false;
  let scope = await getScope(orgId);
  if (scope.boards.has(id)) return true;
  if (Date.now() - scope.at < 1000) return false;
  scope = await loadScope(orgId);
  return scope.boards.has(id);
}

// Middleware factory: `pick` extracts the project key from the request.
export function requireProjectKey(pick) {
  return async (req, res, next) => {
    try {
      if (!(await ownsProjectKey(req.orgId, pick(req)))) return deny(res);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// An issue key is `<PROJECTKEY>-<number>`; the project prefix is what we check.
export const requireIssueScope = requireProjectKey((req) =>
  String(req.params.issueKey || '').split('-')[0]
);

export function requireBoardScope(pick) {
  return async (req, res, next) => {
    try {
      const boardId = pick(req);
      // Absent value: fall through so the handler's own "boardId required" 400
      // still fires. Every route using this guard validates presence itself, so
      // nothing reaches Jira with an empty board id.
      if (boardId === undefined || boardId === null || boardId === '') return next();
      if (!(await ownsBoard(req.orgId, boardId))) return deny(res);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Sprints carry no org marker, and projects.jira_sprint_id only records the
// FIRST sprint, so multi-sprint projects cannot be checked against the table.
// Resolve the sprint's origin board through Jira instead and check that.
export function requireSprintScope(pick) {
  return async (req, res, next) => {
    try {
      const sprintId = String(pick(req) || '');
      if (!/^\d+$/.test(sprintId)) return deny(res);

      const cacheKey = `${req.orgId}:${sprintId}`;
      const hit = sprintBoard.get(cacheKey);
      let boardId = hit && Date.now() - hit.at < TTL_MS ? hit.boardId : null;

      if (boardId === null) {
        const jira = await jiraClientFor(req.orgId);
        const sprint = await jira.getSprintDetails(sprintId);
        boardId = sprint?.originBoardId != null ? String(sprint.originBoardId) : '';
        sprintBoard.set(cacheKey, { at: Date.now(), boardId });
      }

      if (!boardId || !(await ownsBoard(req.orgId, boardId))) return deny(res);
      return next();
    } catch (err) {
      // A sprint the org's token cannot even read is out of scope by definition.
      if (/does not exist|not found|404/i.test(err?.message || '')) return deny(res);
      return next(err);
    }
  };
}
