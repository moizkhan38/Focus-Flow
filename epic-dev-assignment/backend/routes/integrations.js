import express from 'express';
import fetch from 'node-fetch';
import { requireOrgAdmin } from '../middleware/auth.js';
import { sendServerError } from '../utils/httpError.js';
import {
  getStatus,
  setIntegration,
  deleteIntegration,
  getJiraCredentials,
  getGithubToken,
} from '../services/credentialProvider.js';

// Per-org integration credentials API (Phase 2, step 2.4).
//
// requireOrg is enforced upstream by the /api gate in server.js; writes here add
// requireOrgAdmin on top. Tokens are write-only: they are never returned by any
// endpoint and never logged (request bodies for these routes are not logged).

const router = express.Router();

// ─── validation helpers ─────────────────────────────────────────────────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const JIRA_DOMAIN_RE = /^[a-z0-9-]+\.atlassian\.net$/;

// Normalize a user-entered Jira domain: drop protocol, path, and trailing slash.
function normalizeDomain(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function parseJiraError(body, status) {
  if (body?.errorMessages?.length) return body.errorMessages[0];
  if (body?.errors && Object.keys(body.errors).length) return Object.values(body.errors).join(', ');
  if (body?.error_description) return body.error_description;
  return `Jira responded ${status}`;
}

// ─── live credential tests (used before save and by the Test button) ────────
// Return { ok: true, login? } or { ok: false, error } — never throw on auth failure.
async function testJira({ domain, email, apiToken }) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  let res;
  try {
    res = await fetch(`https://${domain}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
  } catch {
    return { ok: false, error: `Could not reach https://${domain}` };
  }
  if (res.ok) {
    const me = await res.json().catch(() => ({}));
    return { ok: true, login: me.emailAddress || me.displayName || email };
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Jira rejected these credentials (check email + API token).' };
  }
  return { ok: false, error: parseJiraError(body, res.status) };
}

async function testGithub({ token }) {
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'FocusFlow',
      },
    });
  } catch {
    return { ok: false, error: 'Could not reach api.github.com' };
  }
  if (res.ok) {
    const user = await res.json().catch(() => ({}));
    return { ok: true, login: user.login || null };
  }
  if (res.status === 401) return { ok: false, error: 'GitHub rejected this token.' };
  return { ok: false, error: `GitHub responded ${res.status}` };
}

// ─── routes ─────────────────────────────────────────────────────────────────

// GET /api/integrations — connection status (any org member). No secrets.
router.get('/integrations', async (req, res) => {
  try {
    res.json({ success: true, ...(await getStatus(req.orgId)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PUT /api/integrations/jira — connect/replace Jira creds (admin only).
router.put('/integrations/jira', requireOrgAdmin, async (req, res) => {
  try {
    const domain = normalizeDomain(req.body?.domain);
    const email = String(req.body?.email || '').trim();
    const apiToken = String(req.body?.apiToken || '');

    if (!JIRA_DOMAIN_RE.test(domain)) {
      return res.status(400).json({ success: false, error: 'Domain must look like yourcompany.atlassian.net' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: 'A valid Atlassian account email is required' });
    }
    if (!apiToken) {
      return res.status(400).json({ success: false, error: 'API token is required' });
    }

    const test = await testJira({ domain, email, apiToken });
    if (!test.ok) return res.status(400).json({ success: false, error: test.error });

    await setIntegration(req.orgId, 'jira', { domain, email, apiToken });
    res.json({ success: true, ...(await getStatus(req.orgId)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PUT /api/integrations/github — connect/replace GitHub PAT (admin only).
router.put('/integrations/github', requireOrgAdmin, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'A GitHub personal access token is required' });
    }

    const test = await testGithub({ token });
    if (!test.ok) return res.status(400).json({ success: false, error: test.error });

    await setIntegration(req.orgId, 'github', { token, login: test.login });
    res.json({ success: true, ...(await getStatus(req.orgId)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// DELETE /api/integrations/:provider — disconnect (admin only).
router.delete('/integrations/:provider', requireOrgAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    if (provider !== 'jira' && provider !== 'github') {
      return res.status(400).json({ success: false, error: 'Unknown provider' });
    }
    await deleteIntegration(req.orgId, provider);
    res.json({ success: true, ...(await getStatus(req.orgId)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/integrations/:provider/test — test the STORED creds (admin only).
router.post('/integrations/:provider/test', requireOrgAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    if (provider === 'jira') {
      const creds = await getJiraCredentials(req.orgId);
      if (!creds) return res.status(400).json({ success: false, error: 'JIRA_NOT_CONNECTED' });
      const test = await testJira(creds);
      return res.json({ success: true, ok: test.ok, ...(test.ok ? {} : { error: test.error }) });
    }
    if (provider === 'github') {
      const token = await getGithubToken(req.orgId);
      if (!token) return res.status(400).json({ success: false, error: 'GITHUB_NOT_CONNECTED' });
      const test = await testGithub({ token });
      return res.json({ success: true, ok: test.ok, ...(test.ok ? {} : { error: test.error }) });
    }
    return res.status(400).json({ success: false, error: 'Unknown provider' });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
