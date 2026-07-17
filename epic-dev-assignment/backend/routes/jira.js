import express from 'express';
import { sendUpstreamError } from '../utils/httpError.js';
import { emitToProject } from '../io.js';
import { jiraClientFor } from '../services/jiraClientFor.js';
import { getJiraCredentials } from '../services/credentialProvider.js';
import { isDoneCategory } from '../services/jiraService.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js.
// Jira credentials are per-org (Phase 2): every handler resolves the caller's
// org client via jiraClientFor(req.orgId). Orgs without a connected Jira get
// 412 JIRA_NOT_CONNECTED (mapped in utils/httpError.js).

router.get('/jira/test', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const user = await jira.testConnection();
    res.json({ ok: true, user: { name: user.displayName, email: user.emailAddress } });
  } catch (err) {
    sendUpstreamError(res, err, { extra: { ok: false } });
  }
});

router.get('/jira/health', async (req, res) => {
  const health = { jira: false, domain: null, flask: false };
  try {
    const creds = await getJiraCredentials(req.orgId);
    if (creds) {
      health.domain = creds.domain;
      const jira = await jiraClientFor(req.orgId);
      const user = await jira.testConnection();
      health.jira = true;
      health.user = user.displayName;
    } else {
      health.jiraError = 'JIRA_NOT_CONNECTED';
    }
  } catch (err) {
    health.jiraError = err.message;
  }
  try {
    const flaskRes = await fetch(`${process.env.FLASK_URL || 'http://localhost:5000'}/api/health`, { signal: AbortSignal.timeout(5000) });
    health.flask = flaskRes.ok;
  } catch { health.flask = false; }
  res.json(health);
});

router.get('/jira/boards', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const boards = await jira.getBoards();
    res.json(boards);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/sprints', async (req, res) => {
  try {
    // No global JIRA_BOARD_ID fallback anymore (per-org world) — the board id
    // comes from the query (frontend stores each project's jira_board_id).
    const boardId = req.query.boardId;
    if (!boardId) {
      return res.status(400).json({ error: 'boardId query parameter is required' });
    }
    const jira = await jiraClientFor(req.orgId);
    const sprints = await jira.getSprints(boardId);
    res.json(sprints);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/sprint/:sprintId', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const sprint = await jira.getSprintDetails(req.params.sprintId);
    res.json(sprint);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/sprint/:sprintId/issues', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const issues = await jira.getSprintIssues(req.params.sprintId);
    res.json(issues);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/sprint/:sprintId/burndown', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const data = await jira.getBurndownData(req.params.sprintId);
    if (req.query.debug) {
      const issues = await jira.getSprintIssues(req.params.sprintId);
      const sprint = await jira.getSprintDetails(req.params.sprintId);
      res.json({
        burndown: data,
        debug: {
          sprintId: req.params.sprintId,
          sprintState: sprint.state,
          sprintStart: sprint.startDate,
          sprintEnd: sprint.endDate,
          issueCount: issues.length,
          issues: issues.map(i => ({
            key: i.key,
            summary: i.summary,
            status: i.status,
            statusCategory: i.statusCategory,
            storyPoints: i.storyPoints,
            issueType: i.issueType,
            resolutionDate: i.resolutionDate,
          })),
        },
      });
    } else {
      res.json(data);
    }
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/project/:projectKey/issues', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const issues = await jira.getProjectIssues(req.params.projectKey);
    res.json(issues);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.get('/jira/issue/:issueKey', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const transitions = await jira.getIssueTransitions(req.params.issueKey);
    res.json({ transitions });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.put('/jira/issue/:issueKey', async (req, res) => {
  try {
    const { transitionId } = req.body;
    if (!transitionId) return res.status(400).json({ error: 'transitionId required' });
    const jira = await jiraClientFor(req.orgId);
    await jira.transitionIssue(req.params.issueKey, transitionId);
    // Broadcast to all clients watching this project so their kanban refreshes instantly
    const projectKey = req.params.issueKey.split('-')[0];
    emitToProject(projectKey, 'issue:changed', { key: req.params.issueKey });
    res.json({ ok: true });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

// ─── Issue Assignment ───────────────────────────────────────────────────────

router.put('/jira/issue/:issueKey/assign', async (req, res) => {
  try {
    const { jiraQuery } = req.body;
    if (!jiraQuery) return res.status(400).json({ error: 'jiraQuery (email or username) is required' });

    const jira = await jiraClientFor(req.orgId);
    const users = await jira.searchUser(jiraQuery);
    if (users.length === 0) {
      return res.status(404).json({ error: `No Jira user found for "${jiraQuery}"` });
    }

    await jira.assignIssue(req.params.issueKey, users[0].accountId);
    const projectKey = req.params.issueKey.split('-')[0];
    emitToProject(projectKey, 'issue:changed', { key: req.params.issueKey });
    res.json({ ok: true, assignee: { name: users[0].displayName, accountId: users[0].accountId } });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

// ─── Sprint Completion ──────────────────────────────────────────────────────

router.get('/jira/board/:boardId/sprints', async (req, res) => {
  try {
    const jira = await jiraClientFor(req.orgId);
    const sprints = await jira.getSprints(req.params.boardId);
    res.json(sprints);
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

router.post('/jira/sprint/:sprintId/complete', async (req, res) => {
  try {
    const { boardId } = req.body;
    const sprintId = req.params.sprintId;
    if (!boardId) return res.status(400).json({ error: 'boardId required' });

    const jira = await jiraClientFor(req.orgId);

    // 1. Get current sprint details + issues
    const [sprint, issues] = await Promise.all([
      jira.getSprintDetails(sprintId),
      jira.getSprintIssues(sprintId),
    ]);

    // 2. Partition issues into done vs incomplete
    const doneIssues = [];
    const incompleteIssues = [];
    for (const issue of issues) {
      if (isDoneCategory(issue.statusCategory || issue.status)) {
        doneIssues.push(issue);
      } else {
        incompleteIssues.push(issue);
      }
    }

    // 3. Find next future sprint
    const allSprints = await jira.getSprints(boardId);
    const futureSprints = allSprints
      .filter(s => s.state === 'future')
      .sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));
    const nextSprint = futureSprints[0] || null;

    // 4. Move incomplete issues to next sprint
    const movedKeys = [];
    if (incompleteIssues.length > 0 && nextSprint) {
      const keys = incompleteIssues.map(i => i.key);
      try {
        await jira.moveIssueToSprint(nextSprint.id, keys);
        movedKeys.push(...keys);
        req.log.info(`[Complete] Moved ${keys.length} incomplete issues to ${nextSprint.name}`);
      } catch (err) {
        req.log.warn(`[Complete] Failed to move issues: ${err.message}`);
      }
    }

    // 5. Close current sprint
    await jira.closeSprint(sprintId);
    req.log.info(`[Complete] Closed sprint: ${sprint.name}`);

    // 6. Start next sprint if exists
    let nextSprintStarted = null;
    if (nextSprint) {
      try {
        const sprintStartDate = nextSprint.startDate || new Date().toISOString();
        const sprintEndDate = nextSprint.endDate || new Date(new Date(sprintStartDate).getTime() + 14 * 86400000).toISOString();
        await jira.startSprint(nextSprint.id, sprintStartDate, sprintEndDate, boardId);
        nextSprintStarted = { id: nextSprint.id, name: nextSprint.name, state: 'active' };
        req.log.info(`[Complete] Started next sprint: ${nextSprint.name}`);
      } catch (err) {
        req.log.warn(`[Complete] Failed to start next sprint: ${err.message}`);
      }
    }

    // 7. Build report
    const donePoints = doneIssues.reduce((s, i) => s + (i.storyPoints || 0), 0);
    const totalPoints = issues.reduce((s, i) => s + (i.storyPoints || 0), 0);
    const issuesByType = {};
    const issuesByPriority = {};
    const issuesByAssignee = {};
    for (const i of issues) {
      issuesByType[i.issueType || 'Unknown'] = (issuesByType[i.issueType || 'Unknown'] || 0) + 1;
      issuesByPriority[i.priority || 'None'] = (issuesByPriority[i.priority || 'None'] || 0) + 1;
      const name = i.assignee?.name || 'Unassigned';
      issuesByAssignee[name] = (issuesByAssignee[name] || 0) + 1;
    }

    const completionRate = issues.length > 0 ? Math.round((doneIssues.length / issues.length) * 100) : 0;
    const report = {
      sprint: { name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate },
      completedIssues: doneIssues.length,
      totalIssues: issues.length,
      completedPoints: donePoints,
      totalPoints,
      completionRate,
      healthScore: { score: completionRate, level: completionRate >= 80 ? 'healthy' : completionRate >= 50 ? 'at-risk' : 'critical' },
      issuesByType,
      issuesByPriority,
      issuesByAssignee,
      issues: issues.map(i => ({
        key: i.key, summary: i.summary, issueType: i.issueType,
        status: i.status, priority: i.priority,
        assignee: i.assignee, storyPoints: i.storyPoints,
      })),
    };

    res.json({
      success: true,
      closedSprint: { id: sprintId, name: sprint.name, state: 'closed' },
      nextSprint: nextSprintStarted,
      movedIssues: movedKeys.length,
      movedIssueKeys: movedKeys,
      report,
      isLastSprint: !nextSprint,
    });
  } catch (err) {
    req.log.error('[Complete] Sprint completion failed:', err.message);
    sendUpstreamError(res, err);
  }
});

export default router;
