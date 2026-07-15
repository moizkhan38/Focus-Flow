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
