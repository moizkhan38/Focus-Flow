// Central place for talking to the backend.
//
// In dev, VITE_API_URL is empty and Vite's proxy forwards /api -> the Express
// gateway. In a production static build there is no proxy, so set VITE_API_URL to
// the backend's origin (e.g. https://api.yourdomain.com) and the same relative
// '/api/...' paths resolve there.
//
// NOTE: anything VITE_-prefixed is PUBLIC (baked into the bundle). Only ever put a
// backend URL here — never a secret.

export const API_BASE = import.meta.env.VITE_API_URL || '';

export const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3003' : window.location.origin);

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// ─── Auth token bridge ───────────────────────────────────────────────────────
// Clerk's getToken() is a React hook product, but the API layer is plain JS.
// AuthBridge (rendered inside ClerkProvider) registers the getter here once, and
// every request pulls a fresh short-lived JWT through it.
let tokenGetter = null;

export function setTokenGetter(fn) {
  tokenGetter = fn;
}

export async function getAuthToken() {
  try {
    return tokenGetter ? await tokenGetter() : null;
  } catch {
    return null;
  }
}

export async function apiFetch(path, opts = {}) {
  const token = await getAuthToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { ...opts, headers });
  if (res.status === 401) {
    // Session expired/invalid — let the app react (Clerk will re-authenticate).
    window.dispatchEvent(new Event('auth:expired'));
  }
  return res;
}

// ─── Typed errors ────────────────────────────────────────────────────────────
// The backend answers 412 { error: 'JIRA_NOT_CONNECTED' | 'GITHUB_NOT_CONNECTED' }
// when the caller's organization hasn't connected that integration yet. That's not
// a failure to shout about — it's a "go connect it" state, so callers check
// err.notConnected and render a connect CTA instead of an error.

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 412 + a *_NOT_CONNECTED code → the org must connect this provider. */
  get notConnected() {
    return this.status === 412 && /_NOT_CONNECTED$/.test(this.code || '');
  }

  /** 'jira' | 'github' | null — which provider needs connecting. */
  get provider() {
    if (!this.notConnected) return null;
    return this.code.replace('_NOT_CONNECTED', '').toLowerCase();
  }
}

const NOT_CONNECTED_COPY = {
  JIRA_NOT_CONNECTED: 'Jira isn’t connected for this organization — connect it under Integrations in the sidebar.',
  GITHUB_NOT_CONNECTED: 'GitHub isn’t connected for this organization — connect it under Integrations in the sidebar.',
};

/**
 * Human-readable text for an error from the API. Machine codes like
 * GITHUB_NOT_CONNECTED become a sentence; everything else passes through
 * (Jira/GitHub messages are the user's own upstream feedback).
 * Accepts an Error, an ApiError, or a raw message string.
 */
export function humanizeError(err) {
  const msg = typeof err === 'string' ? err : err?.message || '';
  return NOT_CONNECTED_COPY[err?.code] || NOT_CONNECTED_COPY[msg] || msg || 'Something went wrong';
}

/**
 * apiFetch + JSON + throw-on-error. Rejects with ApiError carrying the backend's
 * status and error code.
 */
export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error || `Request failed: ${res.status}`, {
      status: res.status,
      code: body.error,
    });
  }
  return body;
}
