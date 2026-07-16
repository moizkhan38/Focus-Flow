#!/usr/bin/env node
/**
 * Focus Flow — smoke test harness (zero dependencies, Node 18+).
 *
 * Exercises the RUNNING stack over HTTP and pins the current API contracts.
 * Run before/after every change; Fable re-runs this at every phase gate of
 * PRODUCTION-PLAN.md. If a step intentionally changes a contract (e.g. adding
 * auth turns 200s into 401s), update the affected checks IN THE SAME COMMIT.
 *
 * AUTH ERA (Phase 1+): the API requires a Clerk session with an active org.
 *   - The `authz` section ALWAYS runs unauthenticated and asserts 401s — it is
 *     the proof that enforcement is on.
 *   - The authed sections (validation, db, integrations, ai) need a real session token:
 *       SMOKE_AUTH_TOKEN=<jwt> node smoke-test.mjs
 *     Get one from the browser: sign in → devtools console →
 *       await window.Clerk.session.getToken()
 *     (Tokens expire in ~60s — grab it right before running.)
 *   - SMOKE_INTERNAL_KEY=<key> additionally exercises the bot's internal lane.
 *
 * PER-ORG ERA (Phase 2+): Jira/GitHub credentials belong to the token's
 * organization, not the environment. The `integrations` section reads
 * GET /api/integrations and asserts whichever contract applies: not connected →
 * 412 JIRA_NOT_CONNECTED / GITHUB_NOT_CONNECTED, connected → the real read paths.
 * Both are correct outcomes; neither is a regression.
 *
 * SAFETY GUARANTEES:
 *   - Never calls POST /api/ai/sync-jira with valid payloads (would create a
 *     real Jira project + send email invites). Only the <2-epics validation
 *     path is probed, which returns 400 before any Jira call.
 *   - Never touches the standup bot's /test/* routes (mass Slack DMs).
 *   - Jira checks are read-only GETs.
 *   - Gemini generation costs quota → only runs with --ai.
 *   - DB roundtrip creates + deletes only its own 'smoke-e2e-test' row.
 *
 * Usage:
 *   node smoke-test.mjs [--ai] [--strict-external]
 * Env overrides:
 *   API_BASE (default http://localhost:3003)   FLASK_BASE (http://localhost:5000)
 *   BOT_BASE (http://localhost:3000)           FRONTEND_BASE (http://localhost:5173)
 */

const API = process.env.API_BASE || 'http://localhost:3003';
const FLASK = process.env.FLASK_BASE || 'http://localhost:5000';
const BOT = process.env.BOT_BASE || 'http://localhost:3000';
const FRONTEND = process.env.FRONTEND_BASE || 'http://localhost:5173';
const RUN_AI = process.argv.includes('--ai');
// With --strict-external, external-dependency failures (Jira creds, bot up)
// count as hard failures instead of warnings.
const STRICT_EXT = process.argv.includes('--strict-external');
const AUTH_TOKEN = process.env.SMOKE_AUTH_TOKEN || '';
const INTERNAL_KEY = process.env.SMOKE_INTERNAL_KEY || '';

const results = [];
let dbUp = false;

function record(section, name, status, detail = '') {
  results.push({ section, name, status, detail });
  const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', SKIP: '⏭️ ' }[status];
  console.log(`${icon} [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function http(method, url, body, timeoutMs = 15000, { auth = true, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const res = await fetch(url, {
      method,
      headers: Object.keys(h).length ? h : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

async function check(section, name, fn, { soft = false } = {}) {
  try {
    const detail = await fn();
    record(section, name, 'PASS', typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    const status = soft && !STRICT_EXT ? 'WARN' : 'FAIL';
    record(section, name, status, err.message);
    return false;
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// ── Express core ─────────────────────────────────────────────────────────────

async function expressChecks() {
  const up = await check('express', 'GET /api/health → 200 running', async () => {
    const r = await http('GET', `${API}/api/health`, undefined, 15000, { auth: false });
    expect(r.status === 200, `status ${r.status}`);
    expect(r.json?.status === 'running', `body: ${r.text.slice(0, 120)}`);
  });
  if (!up) {
    record('express', 'remaining Express checks', 'SKIP', 'backend not reachable');
    return false;
  }

  await check('express', 'GET /api/db/health → db connected (open probe)', async () => {
    const r = await http('GET', `${API}/api/db/health`, undefined, 15000, { auth: false });
    expect(r.status === 200, `status ${r.status}`);
    expect(r.json?.ok === true, `db unreachable: ${r.text.slice(0, 120)}`);
    dbUp = true;
  }, { soft: true });

  await check('express', 'disallowed Origin gets no CORS allow header', async () => {
    const res = await fetch(`${API}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(!res.headers.get('access-control-allow-origin'), 'ACAO header present for hostile origin');
  });

  await check('express', 'Socket.IO engine handshake responds (auth enforced at connect)', async () => {
    const r = await http('GET', `${API}/socket.io/?EIO=4&transport=polling`, undefined, 15000, { auth: false });
    expect(r.status === 200, `status ${r.status}`);
    expect(r.text.startsWith('0{'), `unexpected handshake: ${r.text.slice(0, 40)}`);
  });
  return true;
}

// ── Authorization enforcement (ALWAYS unauthenticated — proves the API is closed) ──

async function authzChecks() {
  const cases = [
    ['POST /api/generate', 'POST', `${API}/api/generate`, { description: 'x' }],
    ['POST /api/regenerate', 'POST', `${API}/api/regenerate`, {}],
    ['POST /api/classify-epics', 'POST', `${API}/api/classify-epics`, {}],
    ['POST /api/analyze-developers', 'POST', `${API}/api/analyze-developers`, {}],
    ['POST /api/auto-assign', 'POST', `${API}/api/auto-assign`, {}],
    ['POST /api/reassign', 'POST', `${API}/api/reassign`, {}],
    ['POST /api/ai/sync-jira', 'POST', `${API}/api/ai/sync-jira`, { projectName: 'x', epics: [] }],
    ['GET  /api/db/projects', 'GET', `${API}/api/db/projects`, undefined],
    ['DELETE /api/db/projects/:id', 'DELETE', `${API}/api/db/projects/smoke-nonexistent`, undefined],
    ['GET  /api/db/developers', 'GET', `${API}/api/db/developers`, undefined],
    ['GET  /api/db/retrospectives', 'GET', `${API}/api/db/retrospectives`, undefined],
    ['POST /api/db/standups (no key, no session)', 'POST', `${API}/api/db/standups`, {}],
    ['GET  /api/jira/sprints', 'GET', `${API}/api/jira/sprints`, undefined],
    ['GET  /api/standup/history', 'GET', `${API}/api/standup/history`, undefined],
    ['GET  /api/integrations', 'GET', `${API}/api/integrations`, undefined],
    ['PUT  /api/integrations/jira', 'PUT', `${API}/api/integrations/jira`, {}],
    ['PUT  /api/integrations/github', 'PUT', `${API}/api/integrations/github`, {}],
    ['DELETE /api/integrations/jira', 'DELETE', `${API}/api/integrations/jira`, undefined],
    ['POST /api/integrations/jira/test', 'POST', `${API}/api/integrations/jira/test`, {}],
  ];
  for (const [name, method, url, body] of cases) {
    await check('authz', `${name} unauthenticated → 401`, async () => {
      const r = await http(method, url, body, 15000, { auth: false });
      expect(r.status === 401, `expected 401, got ${r.status}: ${r.text.slice(0, 100)}`);
    });
  }

  // Internal service lane: with the shared key, the bot reaches validation (400),
  // proving the lane bypasses Clerk but not input checks.
  if (INTERNAL_KEY) {
    await check('authz', 'POST /api/db/standups with X-Internal-Key → 400 (reaches validation)', async () => {
      const r = await http('POST', `${API}/api/db/standups`, {}, 15000,
        { auth: false, headers: { 'X-Internal-Key': INTERNAL_KEY } });
      expect(r.status === 400, `expected 400, got ${r.status}: ${r.text.slice(0, 100)}`);
    });
  } else {
    record('authz', 'internal lane (X-Internal-Key → 400)', 'SKIP', 'set SMOKE_INTERNAL_KEY to test');
  }
}

// ── Validation gauntlet (authed — requires SMOKE_AUTH_TOKEN) ─────────────────

async function validationChecks() {
  if (!AUTH_TOKEN) {
    record('validation', 'authed validation gauntlet', 'SKIP', 'set SMOKE_AUTH_TOKEN (see header)');
    return;
  }
  const cases = [
    ['POST /api/generate {} → 400', 'POST', `${API}/api/generate`, {}],
    ['POST /api/generate short → 400', 'POST', `${API}/api/generate`, { description: 'Build an app' }],
    ['POST /api/generate placeholder → 400', 'POST', `${API}/api/generate`,
      { description: 'this is just a placeholder text for testing the system now' }],
    ['POST /api/regenerate {} → 400', 'POST', `${API}/api/regenerate`, {}],
    ['POST /api/analyze-developers {} → 400', 'POST', `${API}/api/analyze-developers`, {}],
    ['POST /api/auto-assign {} → 400', 'POST', `${API}/api/auto-assign`, {}],
    ['POST /api/auto-assign empty arrays → 400', 'POST', `${API}/api/auto-assign`, { epics: [], developers: [] }],
    ['POST /api/reassign {} → 400', 'POST', `${API}/api/reassign`, {}],
    ['POST /api/ai/sync-jira <2 epics → 400 (pre-Jira)', 'POST', `${API}/api/ai/sync-jira`,
      { projectName: 'Smoke', epics: [], assignments: [] }],
    ['POST /api/db/projects {} → 400', 'POST', `${API}/api/db/projects`, {}],
    ['POST /api/db/developers {} → 400', 'POST', `${API}/api/db/developers`, {}],
  ];
  for (const [name, method, url, body] of cases) {
    await check('validation', name, async () => {
      const r = await http(method, url, body);
      expect(r.status === 400, `expected 400, got ${r.status}: ${r.text.slice(0, 120)}`);
    });
  }

  await check('validation', 'POST /api/classify-epics keyword path → 200 (no Gemini)', async () => {
    const r = await http('POST', `${API}/api/classify-epics`, {
      epics: [{ epic_id: 'E1', epic_title: 'REST API backend endpoints', epic_description: 'server authentication' }],
    });
    expect(r.status === 200, `status ${r.status}`);
    expect(r.json?.success === true, r.text.slice(0, 120));
    const c = r.json.classifications?.[0]?.classification;
    expect(c?.primary === 'Backend Development' && c?.method === 'keyword',
      `unexpected classification: ${JSON.stringify(c)}`);
  });
}

// ── Postgres roundtrip (authed, own row only) ────────────────────────────────

async function dbChecks() {
  if (!AUTH_TOKEN) {
    record('db', 'project CRUD roundtrip', 'SKIP', 'set SMOKE_AUTH_TOKEN');
    return;
  }
  if (!dbUp) {
    record('db', 'project CRUD roundtrip', 'SKIP', 'db not connected');
    return;
  }
  await check('db', 'project CRUD roundtrip (create→read→delete→404)', async () => {
    const id = 'smoke-e2e-test';
    const created = await http('POST', `${API}/api/db/projects`, { id, name: 'Smoke Test Project', status: 'draft' });
    expect(created.status === 201, `create: ${created.status} ${created.text.slice(0, 120)}`);
    const got = await http('GET', `${API}/api/db/projects/${id}`);
    expect(got.status === 200 && got.json?.name === 'Smoke Test Project', `read: ${got.status}`);
    const del = await http('DELETE', `${API}/api/db/projects/${id}`);
    expect(del.status === 200 && del.json?.ok === true, `delete: ${del.status}`);
    const gone = await http('GET', `${API}/api/db/projects/${id}`);
    expect(gone.status === 404, `expected 404 after delete, got ${gone.status}`);
  });
}

// ── Jira + GitHub: per-org integrations (authed) ──────────────────────────────
// Phase 2: credentials are per organization, so what "correct" looks like depends
// on whether THIS token's org has connected them. Both branches are asserted:
//   not connected → 412 *_NOT_CONNECTED (the contract the UI's connect-CTA rides on)
//   connected     → the real read paths still work.

async function integrationChecks() {
  if (!AUTH_TOKEN) {
    record('integrations', 'per-org integration checks', 'SKIP', 'set SMOKE_AUTH_TOKEN');
    return;
  }

  const status = await http('GET', `${API}/api/integrations`, undefined, 15000);
  const ok = await check('integrations', 'GET /api/integrations → status, no secrets', async () => {
    expect(status.status === 200, `status ${status.status}: ${status.text.slice(0, 120)}`);
    expect(typeof status.json?.jira?.connected === 'boolean', 'missing jira.connected');
    expect(typeof status.json?.github?.connected === 'boolean', 'missing github.connected');
    // Tokens are write-only — the status payload must never carry credential material.
    expect(!/ATATT|ghp_|apiToken|"token"/.test(status.text), 'status response leaked token material');
    return `jira=${status.json.jira.connected} github=${status.json.github.connected}`;
  });
  if (!ok) return;

  const jiraConnected = status.json.jira.connected;
  const githubConnected = status.json.github.connected;

  // ── Jira ──
  if (!jiraConnected) {
    await check('jira', 'not connected → 412 JIRA_NOT_CONNECTED', async () => {
      const r = await http('GET', `${API}/api/jira/sprints?boardId=1`, undefined, 15000);
      expect(r.status === 412, `expected 412, got ${r.status}: ${r.text.slice(0, 120)}`);
      expect(r.json?.error === 'JIRA_NOT_CONNECTED', `wrong code: ${r.text.slice(0, 80)}`);
    });
    await check('jira', 'sync-jira not connected → 412', async () => {
      const r = await http('POST', `${API}/api/ai/sync-jira`, { projectName: 'smoke', epics: [], assignments: [] }, 15000);
      expect(r.status === 412, `expected 412, got ${r.status}: ${r.text.slice(0, 120)}`);
    });
  } else {
    await check('jira', 'GET /api/jira/sprints?boardId → array', async () => {
      const boards = await http('GET', `${API}/api/jira/boards`, undefined, 30000);
      expect(boards.status === 200, `boards ${boards.status}`);
      const boardId = boards.json?.[0]?.id;
      if (!boardId) return 'no boards on this Jira site';
      const r = await http('GET', `${API}/api/jira/sprints?boardId=${boardId}`, undefined, 30000);
      expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 120)}`);
      expect(Array.isArray(r.json), `not an array: ${r.text.slice(0, 80)}`);
      return `${r.json.length} sprint(s) on board ${boardId}`;
    }, { soft: true });
    // boardId is required now — the global JIRA_BOARD_ID fallback is gone (2.5).
    await check('jira', 'GET /api/jira/sprints without boardId → 400', async () => {
      const r = await http('GET', `${API}/api/jira/sprints`, undefined, 15000);
      expect(r.status === 400, `expected 400, got ${r.status}: ${r.text.slice(0, 80)}`);
    });
  }

  // ── GitHub ──
  if (!githubConnected) {
    await check('github', 'not connected → 412 GITHUB_NOT_CONNECTED', async () => {
      const r = await http('POST', `${API}/api/analyze-developers`, { github_usernames: ['octocat'] }, 20000);
      expect(r.status === 412, `expected 412, got ${r.status}: ${r.text.slice(0, 120)}`);
      expect(r.json?.error === 'GITHUB_NOT_CONNECTED', `wrong code: ${r.text.slice(0, 80)}`);
    });
  } else {
    record('github', 'analyze-developers (connected)', 'SKIP', 'live GitHub analysis is slow — covered by G2 E2E');
  }
}

// ── Flask generator ──────────────────────────────────────────────────────────

async function flaskChecks() {
  const up = await check('flask', 'GET /api/health → 200', async () => {
    const r = await http('GET', `${FLASK}/api/health`, undefined, 15000, { auth: false });
    expect(r.status === 200, `status ${r.status}`);
  });
  if (!up) {
    record('flask', 'remaining Flask checks', 'SKIP', 'flask not reachable');
    return;
  }
  // Flask gates /api/* behind X-Internal-Key when INTERNAL_API_KEY is set (Step 0.3).
  // Send the shared key (via SMOKE_INTERNAL_KEY) so validation paths are reachable;
  // if the gate is active and no key was provided, skip rather than false-fail.
  const flaskHeaders = INTERNAL_KEY ? { 'X-Internal-Key': INTERNAL_KEY } : {};
  const validationCases = [
    ['POST /api/generate short → 400 (validation, no Gemini)', `${FLASK}/api/generate`, { description: 'x' }],
    ['POST /api/classify {} → 400', `${FLASK}/api/classify`, {}],
  ];
  for (const [name, url, body] of validationCases) {
    const r = await http('POST', url, body, 15000, { auth: false, headers: flaskHeaders });
    if (r.status === 401 && !INTERNAL_KEY) {
      record('flask', name, 'SKIP', 'Flask internal-key gate active — set SMOKE_INTERNAL_KEY');
    } else {
      record('flask', name, r.status === 400 ? 'PASS' : 'FAIL',
        r.status === 400 ? '' : `expected 400, got ${r.status}`);
    }
  }
}

// ── Standup bot (optional service → soft) ────────────────────────────────────

async function botChecks() {
  const up = await check('bot', 'GET /api/health → 200 running', async () => {
    const r = await http('GET', `${BOT}/api/health`, undefined, 8000, { auth: false });
    expect(r.status === 200 && r.json?.status === 'running', `status ${r.status}`);
  }, { soft: true });
  if (!up) {
    record('bot', 'GET /api/standup/history', 'SKIP', 'bot not running (optional)');
    return;
  }
  await check('bot', 'GET /api/standup/history → success', async () => {
    // Filter by a nonexistent project key: exercises route + DB read without
    // triggering the per-entry Slack display-name enrichment (N+1 API calls).
    const r = await http('GET', `${BOT}/api/standup/history?project_key=SMOKE-NONE`, undefined, 20000, { auth: false });
    expect(r.status === 200 && r.json?.success === true, `status ${r.status}: ${r.text.slice(0, 80)}`);
    return `${r.json.standups?.length ?? 0} standup(s) for filter`;
  }, { soft: true });
}

// ── Frontend dev server (optional) ───────────────────────────────────────────

async function frontendChecks() {
  try {
    const r = await http('GET', `${FRONTEND}/`, undefined, 8000, { auth: false });
    if (r.status === 200 && r.text.includes('id="root"')) {
      record('frontend', 'GET / → 200 with #root', 'PASS');
    } else {
      record('frontend', 'GET / → 200 with #root', STRICT_EXT ? 'FAIL' : 'WARN', `status ${r.status}`);
    }
  } catch {
    record('frontend', 'GET / → 200 with #root', 'SKIP', 'dev server not running (optional)');
  }
}

// ── Real AI generation (opt-in: costs Gemini quota, 30–120s) ─────────────────

async function aiChecks() {
  if (!RUN_AI) {
    record('ai', 'full generation Express→Flask→Gemini→parser', 'SKIP', 'pass --ai to enable');
    return;
  }
  if (!AUTH_TOKEN) {
    record('ai', 'full generation Express→Flask→Gemini→parser', 'SKIP', '--ai now needs SMOKE_AUTH_TOKEN');
    return;
  }
  await check('ai', 'POST /api/generate full pipeline → epics with stories', async () => {
    const r = await http('POST', `${API}/api/generate`, {
      description:
        'Build a fitness tracking mobile application with workout logging, nutrition tracking, and progress analytics',
    }, 180000);
    expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    expect(r.json?.success === true, `not success: ${r.text.slice(0, 200)}`);
    const epics = r.json?.result?.epics;
    expect(Array.isArray(epics) && epics.length >= 1, `no epics: ${r.text.slice(0, 200)}`);
    expect(epics[0].epic_id && epics[0].epic_title, 'epic missing id/title');
    expect(Array.isArray(epics[0].user_stories) && epics[0].user_stories.length >= 1, 'no user stories');
    return `${epics.length} epic(s), ${epics.reduce((n, e) => n + (e.user_stories?.length || 0), 0)} stories`;
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`\nFocus Flow smoke tests — ${API}`);
console.log(`auth: ${AUTH_TOKEN ? 'SMOKE_AUTH_TOKEN provided (authed sections ON)' : 'unauthenticated (enforcement checks only)'}\n${'─'.repeat(60)}`);
const expressUp = await expressChecks();
if (expressUp) {
  await authzChecks();
  await validationChecks();
  await dbChecks();
  await integrationChecks();
  await aiChecks();
}
await flaskChecks();
await botChecks();
await frontendChecks();

const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
console.log(`${'─'.repeat(60)}`);
console.log(`PASS ${counts.PASS || 0} · FAIL ${counts.FAIL || 0} · WARN ${counts.WARN || 0} · SKIP ${counts.SKIP || 0}`);
if (counts.FAIL) {
  console.log('\nFailures:');
  results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  ❌ [${r.section}] ${r.name} — ${r.detail}`));
  process.exit(1);
}
console.log('Smoke tests passed.');
