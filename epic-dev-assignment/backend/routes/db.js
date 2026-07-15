import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { requireOrg, orgOrInternal } from '../middleware/auth.js';
import { query, ping } from '../db.js';
import { refreshAllDevelopers } from '../services/developerRefresher.js';

const router = express.Router();

// TENANCY: every query below is scoped to req.orgId (set by requireOrg from the
// Clerk session, or by orgOrInternal from the bot's X-Org-Id). A row is only
// ever visible/mutable inside its own organization.

// ─── Health ─────────────────────────────────────────────────────────────────

router.get('/db/health', async (_req, res) => {
  const ok = await ping();
  res.json({ ok, db: ok ? 'connected' : 'unreachable' });
});

// ─── Standups ───────────────────────────────────────────────────────────────

router.post('/db/standups', orgOrInternal, async (req, res) => {
  try {
    const {
      user_id, project_key, timestamp, yesterday, today, blocker,
      is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
      full_text, raw_analysis,
    } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!req.orgId) {
      // Internal caller must declare its org binding (bot: STANDUP_ORG_ID → X-Org-Id).
      return res.status(400).json({ error: 'X-Org-Id header is required for internal writes' });
    }

    const result = await query(
      `INSERT INTO standups
         (org_id, user_id, project_key, timestamp, yesterday, today, blocker,
          is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
          full_text, raw_analysis)
       VALUES ($1,$2,$3,COALESCE($4, NOW()),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [req.orgId, user_id, project_key || null, timestamp || null, yesterday || null, today || null,
       blocker || null, !!is_blocker, blocker_details || null, sentiment || null,
       finished_tickets || null, today_tickets || null, full_text || null, raw_analysis || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/standups', orgOrInternal, async (req, res) => {
  try {
    const { user_id, project_key, since, limit = 100 } = req.query;
    const conds = [];
    const params = [];
    // Internal callers without an org binding read unscoped (trusted server lane);
    // every org-bound caller (Clerk session or bot with X-Org-Id) is scoped.
    if (req.orgId) { params.push(req.orgId); conds.push(`org_id = $${params.length}`); }
    if (user_id)     { params.push(user_id); conds.push(`user_id = $${params.length}`); }
    if (project_key) { params.push(project_key); conds.push(`project_key = $${params.length}`); }
    if (since)       { params.push(since); conds.push(`timestamp >= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit) || 100, 500));
    const result = await query(
      `SELECT * FROM standups ${where} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Everything below requires a signed-in user with an active organization.
// (Routes above: /db/health is an open probe; /db/standups accept the bot's
// internal-key lane via orgOrInternal.)
router.use(requireOrg);

// ─── Retrospectives ─────────────────────────────────────────────────────────

router.post('/db/retrospectives', async (req, res) => {
  try {
    const {
      project_id, sprint_id, sprint_name,
      went_well = [], went_wrong = [], actions = [], created_by,
    } = req.body;
    const result = await query(
      `INSERT INTO retrospectives
         (org_id, project_id, sprint_id, sprint_name, went_well, went_wrong, actions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.orgId, project_id || null, sprint_id || null, sprint_name || null,
       went_well, went_wrong, actions, created_by || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/retrospectives', async (req, res) => {
  try {
    const { project_id, sprint_id } = req.query;
    const conds = ['org_id = $1'];
    const params = [req.orgId];
    if (project_id) { params.push(project_id); conds.push(`project_id = $${params.length}`); }
    if (sprint_id)  { params.push(sprint_id); conds.push(`sprint_id = $${params.length}`); }
    const result = await query(
      `SELECT * FROM retrospectives WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

// ─── Projects ───────────────────────────────────────────────────────────────

router.post('/db/projects', async (req, res) => {
  try {
    const {
      id, name, description, status = 'draft',
      jira_project_key, jira_board_id, jira_sprint_id,
      deadline, sprint_count, raw,
    } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

    // Upsert, but NEVER across orgs: if the id exists in another org, the WHERE
    // clause blocks the update and RETURNING comes back empty → 409.
    const result = await query(
      `INSERT INTO projects
         (id, org_id, name, description, status, jira_project_key, jira_board_id,
          jira_sprint_id, deadline, sprint_count, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         name             = EXCLUDED.name,
         description      = EXCLUDED.description,
         status           = EXCLUDED.status,
         jira_project_key = EXCLUDED.jira_project_key,
         jira_board_id    = EXCLUDED.jira_board_id,
         jira_sprint_id   = EXCLUDED.jira_sprint_id,
         deadline         = EXCLUDED.deadline,
         sprint_count     = EXCLUDED.sprint_count,
         raw              = EXCLUDED.raw
       WHERE projects.org_id = EXCLUDED.org_id
       RETURNING *`,
      [id, req.orgId, name, description || null, status, jira_project_key || null,
       jira_board_id || null, jira_sprint_id || null, deadline || null,
       sprint_count || 1, raw || null]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'A project with this id exists in another organization' });
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/projects', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/projects/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM projects WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/db/projects/:id', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM projects WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ─── Developers ─────────────────────────────────────────────────────────────

router.post('/db/developers', async (req, res) => {
  try {
    const {
      username, email, jira_username, avatar_url, primary_expertise, experience_level,
      top_skills, analysis, availability,
    } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const result = await query(
      `INSERT INTO developers
         (org_id, username, email, jira_username, avatar_url, primary_expertise, experience_level,
          top_skills, analysis, availability)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (org_id, username) DO UPDATE SET
         email             = COALESCE(EXCLUDED.email,             developers.email),
         jira_username     = COALESCE(EXCLUDED.jira_username,     developers.jira_username),
         avatar_url        = COALESCE(EXCLUDED.avatar_url,        developers.avatar_url),
         primary_expertise = COALESCE(EXCLUDED.primary_expertise, developers.primary_expertise),
         experience_level  = COALESCE(EXCLUDED.experience_level,  developers.experience_level),
         top_skills        = COALESCE(EXCLUDED.top_skills,        developers.top_skills),
         analysis          = COALESCE(EXCLUDED.analysis,          developers.analysis),
         availability      = COALESCE(EXCLUDED.availability,      developers.availability)
       RETURNING *`,
      [req.orgId, username, email || null, jira_username || null, avatar_url || null, primary_expertise || null,
       experience_level || null, top_skills || null, analysis || null, availability || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/developers', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM developers WHERE org_id = $1 ORDER BY added_at DESC`,
      [req.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/db/developers/:username', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM developers WHERE username = $1 AND org_id = $2`,
      [req.params.username, req.orgId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Manually trigger a refresh of every developer's GitHub stats.
// The same job runs automatically on a daily cron (see server.js).
router.post('/db/developers/refresh', async (req, res) => {
  try {
    const summary = await refreshAllDevelopers();
    // Return the freshly-updated rows for THIS org so the frontend can replace its cache.
    const { rows } = await query(
      `SELECT * FROM developers WHERE org_id = $1 ORDER BY username`,
      [req.orgId]
    );
    res.json({ ...summary, developers: rows });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ─── Assignments ────────────────────────────────────────────────────────────

router.post('/db/assignments/bulk', async (req, res) => {
  try {
    const { project_id, assignments = [] } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });

    // The target project must belong to the caller's org.
    const owns = await query(
      `SELECT 1 FROM projects WHERE id = $1 AND org_id = $2`,
      [project_id, req.orgId]
    );
    if (owns.rows.length === 0) {
      return res.status(403).json({ error: 'Project does not belong to your organization' });
    }

    // Replace all assignments for this project
    await query(`DELETE FROM assignments WHERE project_id = $1 AND org_id = $2`, [project_id, req.orgId]);
    for (const a of assignments) {
      await query(
        `INSERT INTO assignments
           (org_id, project_id, epic_id, epic_title, story_id, story_title, story_points,
            developer_username, score, confidence, jira_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.orgId, project_id, a.epic_id || null, a.epic_title || null, a.story_id || null,
         a.story_title || null, a.story_points || null, a.assigned_developer || a.developer_username || null,
         a.score || null, a.confidence || null, a.jira_key || null]
      );
    }
    res.status(201).json({ ok: true, count: assignments.length });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/assignments', async (req, res) => {
  try {
    const { project_id, developer_username } = req.query;
    const conds = ['org_id = $1'];
    const params = [req.orgId];
    if (project_id)         { params.push(project_id); conds.push(`project_id = $${params.length}`); }
    if (developer_username) { params.push(developer_username); conds.push(`developer_username = $${params.length}`); }
    const result = await query(
      `SELECT * FROM assignments WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
