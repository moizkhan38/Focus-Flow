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

export function apiFetch(path, opts) {
  return fetch(apiUrl(path), opts);
}
