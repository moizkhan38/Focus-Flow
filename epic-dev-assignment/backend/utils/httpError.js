// Centralized error responders so internal details never reach clients.

// Internal failures (DB, filesystem, service proxies we don't sanitize). Logs the
// real error server-side and returns a safe, generic message to the caller.
export function sendServerError(res, err, publicMessage = 'Internal server error', status = 500) {
  console.error('[API error]', err);
  if (res.headersSent) return;
  res.status(status).json({ success: false, error: publicMessage });
}

// Errors whose message is ALREADY user-safe — specifically Jira Cloud API errors
// that jiraService.parseJiraError() reduced to the caller's own Jira feedback
// (errorMessages[] / errors{} / error_description). The SyncButton UI surfaces
// these to help users fix their Jira setup, so the message is safe to return.
// Still logged. Optional `extra` preserves endpoint-specific shapes (e.g. { ok:false }).
export function sendUpstreamError(res, err, { status = 500, extra = {} } = {}) {
  console.error('[Upstream error]', err);
  if (res.headersSent) return;
  res.status(status).json({ ...extra, error: err.message || 'Upstream service error' });
}
