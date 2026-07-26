import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { query } from '../db.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js (requireOrg), so
// req.orgId is always the caller's own organization by the time we get here.

// GET /api/standup/history — this organization's standups.
//
// SECURITY: reads Postgres scoped by req.orgId. It used to proxy to the standup
// bot, but the bot is bound to exactly ONE organization (STANDUP_ORG_ID, D6) and
// answers with that org's data regardless of who asked — so every authenticated
// user of every tenant received the bot-bound org's standups, including blocker
// details and ticket ids. Reading the org-scoped table removes the cross-tenant
// leak at the source.
//
// It also removes an availability coupling: standup history no longer disappears
// when the optional bot is down, because the rows were always in Postgres.
//
// Trade-off: the bot used to enrich rows with Slack display names and avatars via
// users_info. Those are not stored on the row, so the UI falls back to the Slack
// user id (it already renders `user_name || user_id`). Persisting the display
// name at write time would restore it without reintroducing the proxy.
router.get('/standup/history', async (req, res) => {
  try {
    const { project_key } = req.query;

    const params = [req.orgId];
    let where = 'org_id = $1';
    if (project_key) {
      params.push(project_key);
      where += ` AND project_key = $${params.length}`;
    }
    params.push(200);

    const result = await query(
      `SELECT * FROM standups WHERE ${where} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    return res.json({ success: true, standups: result.rows });
  } catch (error) {
    return sendServerError(res, error, 'Failed to load standup history');
  }
});

// NOTE: there was a POST /api/standup here that proxied a standup submission to
// the bot. It was removed deliberately.
//
// Nothing called it — standups originate in Slack, where the bot verifies the
// request signature — but it accepted a body from ANY authenticated user of ANY
// tenant and had the bot act on it against the bot-bound organization's Jira and
// Slack workspace. That is a cross-tenant write with no legitimate caller, so the
// safe fix is to delete the surface rather than guard it.

export default router;
