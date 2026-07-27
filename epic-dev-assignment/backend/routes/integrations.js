import express from 'express';
import fetch from 'node-fetch';
import { requireOrgAdmin } from '../middleware/auth.js';
import { requireFeature } from '../middleware/requirePlan.js';
import { FEATURES } from '../services/billing.js';
import { sendServerError } from '../utils/httpError.js';
import { query } from '../db.js';
import {
  getStatus,
  setIntegration,
  deleteIntegration,
  getJiraCredentials,
  getGithubToken,
  getSlackCredentials,
  getGeminiKey,
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

// The Slack analyzer URL is supplied by an org admin and the standup bot then
// POSTs standup content to it from INSIDE the private service network. Without
// validation that is a blind SSRF sink: a tenant could point it at
// http://169.254.169.254/ (cloud metadata), at Postgres, or at another internal
// service, and use the bot as a proxy to reach things the internet cannot.
//
// Hostname checks cannot be airtight — DNS can resolve a public name to a private
// address, and can change between this check and the bot's request. This blocks
// the obvious cases and forces https so the payload is not sent in the clear.
// Egress restrictions on the bot's network are the real control.
const PRIVATE_HOST_RE = new RegExp(
  [
    '^localhost$', '^127\\.', '^0\\.', '^10\\.', '^192\\.168\\.',
    '^172\\.(1[6-9]|2[0-9]|3[01])\\.',      // 172.16.0.0/12
    '^169\\.254\\.',                         // link-local + cloud metadata
    '^\\[?::1\\]?$', '^\\[?f[cd]',           // IPv6 loopback + unique-local
    '\\.internal$', '\\.local$', '\\.localdomain$',
  ].join('|'),
  'i'
);

function validateOutboundUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'That is not a valid URL.';
  }
  if (u.protocol !== 'https:') {
    return 'Analyzer URL must use https:// — standup content is sent to it.';
  }
  if (PRIVATE_HOST_RE.test(u.hostname)) {
    return 'That host is not reachable from the standup service (private or link-local address).';
  }
  return null;
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

// Listing models is the cheapest authenticated call that proves a Gemini key
// works. A key that is syntactically valid but has no quota still lists models,
// so this validates authentication, not entitlement.
async function testGemini({ apiKey }) {
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
  } catch {
    return { ok: false, error: 'Could not reach generativelanguage.googleapis.com' };
  }
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, modelCount: (body.models || []).length };
  }
  if (res.status === 400 || res.status === 403) {
    return { ok: false, error: 'Google rejected this API key. Check it was copied in full from AI Studio.' };
  }
  if (res.status === 429) {
    return { ok: false, error: 'The key is valid but is currently rate-limited (429).' };
  }
  return { ok: false, error: `Google responded ${res.status}` };
}

// auth.test needs no scope and returns the workspace name — ideal for validating
// a pasted bot token before we store it.
async function testSlack({ botToken }) {
  let res;
  try {
    res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  } catch {
    return { ok: false, error: 'Could not reach slack.com' };
  }
  const body = await res.json().catch(() => ({}));
  // Slack returns HTTP 200 with { ok: false, error } for bad tokens.
  if (body.ok) return { ok: true, teamName: body.team || null, botUser: body.user || null };
  const map = {
    invalid_auth: 'Slack rejected this bot token.',
    account_inactive: 'That token belongs to a deactivated workspace or app.',
    token_revoked: 'This token has been revoked — reinstall the app and copy the new one.',
    not_authed: 'No token was sent.',
  };
  return { ok: false, error: map[body.error] || `Slack responded: ${body.error || 'unknown error'}` };
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

// ─── standup bot (Slack) ────────────────────────────────────────────────────
// Read-only status, not a credential form. Per decision D6 the bot is bound to
// ONE Slack workspace and ONE org via its own env; a workspace cannot be
// connected from the UI because Slack requires an OAuth install, not a pasted
// token (Phase 4). So this reports reality rather than pretending to configure it.

const FOCUS_FLOW_URL = process.env.FOCUS_FLOW_URL || 'http://localhost:3000';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

async function fetchBotStatus() {
  const controller = new AbortController();
  // Settings must stay responsive when the bot is down — it often is, since the
  // bot is optional and currently not deployed.
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(`${FOCUS_FLOW_URL}/api/standup/status`, {
      headers: INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {},
      signal: controller.signal,
    });
    if (r.status === 401) return { reachable: true, authorized: false };
    if (!r.ok) return { reachable: true, authorized: true, error: `Bot responded ${r.status}` };
    return { reachable: true, authorized: true, ...(await r.json()) };
  } catch {
    return { reachable: false, authorized: false };
  } finally {
    clearTimeout(timer);
  }
}

// PUT /api/integrations/slack — store this org's Slack app credentials (admin only).
// The org admin creates the Slack app themselves and pastes its bot token and
// signing secret here; no OAuth install flow is involved (that's Phase 4, and is
// only needed to serve MANY workspaces from one app).
router.put('/integrations/slack', requireOrgAdmin, requireFeature(FEATURES.STANDUP_BOT, 'The Slack standup bot is a paid feature.'), async (req, res) => {
  try {
    const botToken = String(req.body?.botToken || '').trim();
    const signingSecret = String(req.body?.signingSecret || '').trim();
    const analyzerUrl = String(req.body?.analyzerUrl || '').trim();

    if (!botToken || !signingSecret) {
      return res.status(400).json({ success: false, error: 'botToken and signingSecret are required' });
    }
    if (!botToken.startsWith('xoxb-')) {
      return res.status(400).json({
        success: false,
        error: 'Expected a bot token starting with "xoxb-". Copy the Bot User OAuth Token, not the app or user token.',
      });
    }
    if (analyzerUrl) {
      const urlError = validateOutboundUrl(analyzerUrl);
      if (urlError) return res.status(400).json({ success: false, error: urlError });
    }

    const test = await testSlack({ botToken });
    if (!test.ok) return res.status(400).json({ success: false, error: test.error });

    await setIntegration(req.orgId, 'slack', {
      botToken,
      signingSecret,
      analyzerUrl: analyzerUrl || null,
      teamName: test.teamName,
    });
    return res.json({ success: true, teamName: test.teamName });
  } catch (err) {
    return sendServerError(res, err);
  }
});


// GET /api/integrations/slack — standup bot status for this org (any member).
router.get('/integrations/slack', async (req, res) => {
  try {
    const [bot, counts, stored] = await Promise.all([
      fetchBotStatus(),
      query(
        `SELECT COUNT(*)::int AS total, MAX(timestamp) AS last_at
           FROM standups WHERE org_id = $1`,
        [req.orgId]
      ).then((r) => r.rows[0]).catch(() => ({ total: 0, last_at: null })),
      getStatus(req.orgId).then((s) => s.slack).catch(() => ({ connected: false })),
    ]);

    // "Bound to this org" is what decides whether standups submitted in Slack
    // will actually surface here — surface it plainly rather than as a boolean.
    const boundToThisOrg = !!bot.orgId && bot.orgId === req.orgId;

    res.json({
      success: true,
      slack: {
        // Public URL Slack will call. Not a secret — it is exactly what gets
        // typed into the Slack app config — and the UI needs it to build the
        // app manifest for the user.
        botUrl: FOCUS_FLOW_URL,

        // Credentials saved here, independent of whether the bot is running.
        credentialsStored: !!stored.connected,
        teamName: stored.teamName || null,
        // The analyzer URL is a webhook endpoint, and for every common provider
        // (hooks.slack.com/services/…, Zapier, Make, n8n) the PATH ITSELF is the
        // credential — anyone holding the URL can post as you. Returning it to
        // every org member contradicted the write-only rule the rest of this file
        // follows, so only the host is surfaced; the UI needs no more than that.
        analyzerConfigured: !!stored.analyzerConfigured,
        analyzerHost: stored.analyzerHost || null,
        tokenSuffix: stored.tokenSuffix || null,

        reachable: bot.reachable,
        authorized: bot.authorized !== false,
        connected: !!(bot.reachable && bot.authorized !== false && bot.configured?.slack),
        // Only ever reveal the bot's workspace when it is bound to the CALLER's
        // org. The bot serves one org (D6) and answers with that org's details
        // regardless of who asks, so echoing them unconditionally handed any
        // signed-in member of any tenant another tenant's Clerk org id and Slack
        // workspace name.
        workspace: boundToThisOrg ? (bot.workspace || null) : null,
        boundToThisOrg,
        reminder: bot.reminder || null,
        jiraProjectKey: bot.jiraProjectKey || null,
        configured: bot.configured || null,
        // 'integrations' = the bot picked up what was pasted here; 'env' = it is
        // still running on its own .env values.
        credentialSource: bot.credentialSource || null,
        error: bot.error || null,
        standupCount: counts.total || 0,
        lastStandupAt: counts.last_at || null,
      },
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

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

// PUT /api/integrations/gemini — store an OPTIONAL per-org Gemini key (admin only).
// D5 keeps the platform key as the default; this only overrides it for this org.
router.put('/integrations/gemini', requireOrgAdmin, async (req, res) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'An API key is required' });
    }

    const test = await testGemini({ apiKey });
    if (!test.ok) return res.status(400).json({ success: false, error: test.error });

    await setIntegration(req.orgId, 'gemini', { apiKey });
    return res.json({ success: true, modelCount: test.modelCount });
  } catch (err) {
    return sendServerError(res, err);
  }
});

// DELETE /api/integrations/:provider — disconnect (admin only).
router.delete('/integrations/:provider', requireOrgAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    if (!['jira', 'github', 'slack', 'gemini'].includes(provider)) {
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
    if (provider === 'slack') {
      const creds = await getSlackCredentials(req.orgId);
      if (!creds) return res.status(400).json({ success: false, error: 'SLACK_NOT_CONNECTED' });
      const test = await testSlack({ botToken: creds.botToken });
      return res.json({
        success: true,
        ok: test.ok,
        ...(test.ok ? { teamName: test.teamName } : { error: test.error }),
      });
    }
    if (provider === 'gemini') {
      const apiKey = await getGeminiKey(req.orgId);
      if (!apiKey) return res.status(400).json({ success: false, error: 'GEMINI_NOT_CONNECTED' });
      const test = await testGemini({ apiKey });
      return res.json({ success: true, ok: test.ok, ...(test.ok ? {} : { error: test.error }) });
    }
    return res.status(400).json({ success: false, error: 'Unknown provider' });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
