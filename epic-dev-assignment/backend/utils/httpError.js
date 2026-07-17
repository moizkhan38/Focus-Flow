// Centralized error responders so internal details never reach clients.
import { logger } from '../logger.js';

// Prefer the request-scoped child logger (carries the reqId) when we have it,
// so an error line correlates with the rest of that request's logs.
const logOf = (res) => res?.req?.log || logger;

// Per-org integrations (Phase 2): IntegrationNotConnectedError carries a code
// like JIRA_NOT_CONNECTED / GITHUB_NOT_CONNECTED. Mapped to 412 so the frontend
// can show a "Connect X in Settings" state instead of a generic failure.
export function sendNotConnectedIfApplicable(res, err) {
  if (err?.name !== 'IntegrationNotConnectedError') return false;
  if (!res.headersSent) {
    res.status(412).json({ success: false, error: err.code });
  }
  return true;
}

// Internal failures (DB, filesystem, service proxies we don't sanitize). Logs the
// real error server-side and returns a safe, generic message to the caller.
export function sendServerError(res, err, publicMessage = 'Internal server error', status = 500) {
  if (sendNotConnectedIfApplicable(res, err)) return;
  logOf(res).error({ err }, 'API error');
  if (res.headersSent) return;
  res.status(status).json({ success: false, error: publicMessage });
}

// Errors whose message is ALREADY user-safe — specifically Jira Cloud API errors
// that jiraService.parseJiraError() reduced to the caller's own Jira feedback
// (errorMessages[] / errors{} / error_description). The SyncButton UI surfaces
// these to help users fix their Jira setup, so the message is safe to return.
// Still logged. Optional `extra` preserves endpoint-specific shapes (e.g. { ok:false }).
export function sendUpstreamError(res, err, { status = 500, extra = {} } = {}) {
  if (sendNotConnectedIfApplicable(res, err)) return;
  logOf(res).error({ err }, 'upstream error');
  if (res.headersSent) return;
  res.status(status).json({ ...extra, error: err.message || 'Upstream service error' });
}
