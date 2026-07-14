import express from 'express';
import { sendServerError } from '../utils/httpError.js';

const router = express.Router();
const FOCUS_FLOW_URL = process.env.FOCUS_FLOW_URL || 'http://localhost:3000';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Attach the shared internal-service key so the bot (when gated in production)
// accepts these server-to-server calls. No-op locally when the key is unset.
function botHeaders(base = {}) {
  return INTERNAL_API_KEY ? { ...base, 'X-Internal-Key': INTERNAL_API_KEY } : base;
}

router.post('/standup', async (req, res) => {
  try {
    const response = await fetch(`${FOCUS_FLOW_URL}/api/standup`, {
      method: 'POST',
      headers: botHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(response.status).json({ success: response.ok, ...data });
  } catch (error) {
    console.error('Error proxying standup request:', error);
    return sendServerError(res, error, 'Standup proxy failed');
  }
});

router.get('/standup/history', async (req, res) => {
  try {
    const projectKey = req.query.project_key ? `?project_key=${req.query.project_key}` : '';
    const response = await fetch(`${FOCUS_FLOW_URL}/api/standup/history${projectKey}`, {
      headers: botHeaders(),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Error fetching standup history:', error);
    return res.status(500).json({ success: false, error: 'Standup bot is not running or unreachable.', standups: [] });
  }
});

export default router;
