import express from 'express';
import { billingStatus, invalidateEntitlement } from '../services/billing.js';
import { sendServerError } from '../utils/httpError.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js.

// GET /api/billing/status — the caller's org plan, features and metered usage.
// Any member may read it: the sidebar shows the plan and remaining allowance to
// everyone, and only the checkout itself is admin-gated (by Clerk).
router.get('/billing/status', async (req, res) => {
  try {
    res.json({ success: true, ...(await billingStatus(req)) });
  } catch (err) {
    sendServerError(res, err, 'Could not load billing status');
  }
});

// POST /api/billing/refresh — drop the cached entitlement for this org.
//
// Entitlement is cached for 60s, and a checkout that has just completed would
// otherwise appear not to have worked for up to a minute. The billing page calls
// this on return from checkout so the upgrade is visible immediately.
router.post('/billing/refresh', async (req, res) => {
  try {
    invalidateEntitlement(req.orgId);
    res.json({ success: true, ...(await billingStatus(req)) });
  } catch (err) {
    sendServerError(res, err, 'Could not refresh billing status');
  }
});

export default router;
