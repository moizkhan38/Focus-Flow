import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { getSlackCredentials, getJiraCredentials } from '../services/credentialProvider.js';

// Internal service lane: the standup bot resolving the ORG's stored credentials
// instead of carrying its own copies in env.
//
// MOUNTED FIRST, DELIBERATELY. Every router in this app is mounted at '/api',
// so a request passes through all of them in order until one matches. dbRouter
// applies a blanket `router.use(requireOrg)`, which rejects any request that
// reaches it without a Clerk session — including these. Mounting this router
// ahead of the others is what keeps that from happening; moving it later
// silently breaks the bot with a 401 that looks like a bad key.
//
// Auth is enforced by the /api gate in server.js via requireInternal: internal
// key only, no Clerk fallback, so a signed-in user (admin or not) can never
// read decrypted credentials back out.
//
// TRADE-OFF, taken deliberately: these hand plaintext secrets to the Python bot
// over HTTP because credentialProvider is Node. Mitigated by the internal-key
// gate and by both services sharing a private network. The alternative was a
// second implementation of the AES-256-GCM envelope in Python, and a second
// copy of the master key.

const router = express.Router();

// GET /api/internal/slack-config — Slack bot token, signing secret, analyzer URL.
router.get('/slack-config', async (req, res) => {
  try {
    // requireInternal is attached at the mount in server.js. This second check
    // makes the handler refuse on its own if that mount is ever changed, so a
    // routing mistake cannot silently expose credentials again.
    if (!req.internal) {
      return res.status(401).json({ success: false, error: 'INTERNAL_AUTH_REQUIRED' });
    }
    if (!req.orgId) {
      return res.status(400).json({ success: false, error: 'X-Org-Id header is required' });
    }
    const creds = await getSlackCredentials(req.orgId);
    if (!creds) return res.status(404).json({ success: false, error: 'SLACK_NOT_CONNECTED' });
    return res.json({
      success: true,
      botToken: creds.botToken,
      signingSecret: creds.signingSecret,
      analyzerUrl: creds.analyzerUrl,
      teamName: creds.teamName,
    });
  } catch (err) {
    return sendServerError(res, err);
  }
});

// GET /api/internal/jira-config — the org's Jira credentials.
//
// Without this the bot and the app can point at different Atlassian sites: the
// app creates projects in the org's Jira while the bot lists projects from its
// own env, so newly created projects never appear in the /standup picker.
router.get('/jira-config', async (req, res) => {
  try {
    // requireInternal is attached at the mount in server.js. This second check
    // makes the handler refuse on its own if that mount is ever changed, so a
    // routing mistake cannot silently expose credentials again.
    if (!req.internal) {
      return res.status(401).json({ success: false, error: 'INTERNAL_AUTH_REQUIRED' });
    }
    if (!req.orgId) {
      return res.status(400).json({ success: false, error: 'X-Org-Id header is required' });
    }
    const creds = await getJiraCredentials(req.orgId);
    if (!creds) return res.status(404).json({ success: false, error: 'JIRA_NOT_CONNECTED' });
    return res.json({
      success: true,
      domain: creds.domain,
      email: creds.email,
      apiToken: creds.apiToken,
    });
  } catch (err) {
    return sendServerError(res, err);
  }
});

export default router;
