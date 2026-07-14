import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { query, ping } from '../db.js';
import { refreshAllDevelopers } from '../services/developerRefresher.js';

const router = express.Router();

// ─── Health ─────────────────────────────────────────────────────────────────

router.get('/db/health', async (_req, res) => {
  const ok = await ping();
  res.json({ ok, db: ok ? 'connected' : 'unreachable' });
});

// ─── Standups ───────────────────────────────────────────────────────────────

router.post('/db/standups', async (req, res) => {
  try {
    const {
      user_id, project_key, timestamp, yesterday, today, blocker,
      is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
      full_text, raw_analysis,
    } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const result = await query(
      `INSERT INTO standups
         (user_id, project_key, timestamp, yesterday, today, blocker,
          is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
          full_text, raw_analysis)
       VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [user_id, project_key || null, timestamp || null, yesterday || null, today || null,
       blocker || null, !!is_blocker, blocker_details || null, sentiment || null,
       finished_tickets || null, today_tickets || null, full_text || null, raw_analysis || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/standups', async (req, res) => {
  try {
    const { user_id, project_key, since, limit = 100 } = req.query;
    const conds = [];
    const params = [];
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

// ─── Retrospectives ─────────────────────────────────────────────────────────

router.post('/db/retrospectives', async (req, res) => {
  try {
    const {
      project_id, sprint_id, sprint_name,
      went_well = [], went_wrong = [], actions = [], created_by,
    } = req.body;
    const result = await query(
      `INSERT INTO retrospectives
         (project_id, sprint_id, sprint_name, went_well, went_wrong, actions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [project_id || null, sprint_id || null, sprint_name || null,
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
    const conds = [];
    const params = [];
    if (project_id) { params.push(project_id); conds.push(`project_id = $${params.length}`); }
    if (sprint_id)  { params.push(sprint_id); conds.push(`sprint_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await query(
      `SELECT * FROM retrospectives ${where} ORDER BY created_at DESC`,
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

    const result = await query(
      `INSERT INTO projects
         (id, name, description, status, jira_project_key, jira_board_id,
          jira_sprint_id, deadline, sprint_count, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
       RETURNING *`,
      [id, name, description || null, status, jira_project_key || null,
       jira_board_id || null, jira_sprint_id || null, deadline || null,
       sprint_count || 1, raw || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/projects', async (_req, res) => {
  try {
    const result = await query(`SELECT * FROM projects ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/projects/:id', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/db/projects/:id', async (req, res) => {
  try {
    await query(`DELETE FROM projects WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ─── Developers ─────────────────────────────────────────────────────────────

router.post('/db/developers', async (req, res) => {
  try {
    const {
      username, jira_username, avatar_url, primary_expertise, experience_level,
      top_skills, analysis, availability,
    } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const result = await query(
      `INSERT INTO developers
         (username, jira_username, avatar_url, primary_expertise, experience_level,
          top_skills, analysis, availability)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (username) DO UPDATE SET
         jira_username     = COALESCE(EXCLUDED.jira_username,     developers.jira_username),
         avatar_url        = COALESCE(EXCLUDED.avatar_url,        developers.avatar_url),
         primary_expertise = COALESCE(EXCLUDED.primary_expertise, developers.primary_expertise),
         experience_level  = COALESCE(EXCLUDED.experience_level,  developers.experience_level),
         top_skills        = COALESCE(EXCLUDED.top_skills,        developers.top_skills),
         analysis          = COALESCE(EXCLUDED.analysis,          developers.analysis),
         availability      = COALESCE(EXCLUDED.availability,      developers.availability)
       RETURNING *`,
      [username, jira_username || null, avatar_url || null, primary_expertise || null,
       experience_level || null, top_skills || null, analysis || null, availability || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/db/developers', async (_req, res) => {
  try {
    const result = await query(`SELECT * FROM developers ORDER BY added_at DESC`);
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/db/developers/:username', async (req, res) => {
  try {
    await query(`DELETE FROM developers WHERE username = $1`, [req.params.username]);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Manually trigger a refresh of every developer's GitHub stats.
// The same job runs automatically on a daily cron (see server.js).
router.post('/db/developers/refresh', async (_req, res) => {
  try {
    const summary = await refreshAllDevelopers();
    // Return the freshly-updated rows so the frontend can replace its local cache.
    const { rows } = await query(`SELECT * FROM developers ORDER BY username`);
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

    // Replace all assignments for this project in a single transaction
    await query(`DELETE FROM assignments WHERE project_id = $1`, [project_id]);
    for (const a of assignments) {
      await query(
        `INSERT INTO assignments
           (project_id, epic_id, epic_title, story_id, story_title, story_points,
            developer_username, score, confidence, jira_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [project_id, a.epic_id || null, a.epic_title || null, a.story_id || null,
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
    const conds = [];
    const params = [];
    if (project_id)         { params.push(project_id); conds.push(`project_id = $${params.length}`); }
    if (developer_username) { params.push(developer_username); conds.push(`developer_username = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await query(
      `SELECT * FROM assignments ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
