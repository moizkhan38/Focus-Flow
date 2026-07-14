#!/usr/bin/env node
/**
 * Focus Flow — smoke test harness (zero dependencies, Node 18+).
 *
 * Exercises the RUNNING stack over HTTP and pins the current API contracts.
 * Run before/after every change; Fable re-runs this at every phase gate of
 * PRODUCTION-PLAN.md. If a step intentionally changes a contract (e.g. adding
 * auth turns 200s into 401s), update the affected checks IN THE SAME COMMIT.
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

const results = [];
let dbUp = false;

function record(section, name, status, detail = '') {
  results.push({ section, name, status, detail });
  const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', SKIP: '⏭️ ' }[status];
  console.log(`${icon} [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function http(method, url, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
    const r = await http('GET', `${API}/api/health`);
    expect(r.status === 200, `status ${r.status}`);
    expect(r.json?.status === 'running', `body: ${r.text.slice(0, 120)}`);
  });
  if (!up) {
    record('express', 'remaining Express checks', 'SKIP', 'backend not reachable');
    return false;
  }

  await check('express', 'GET /api/db/health → db connected', async () => {
    const r = await http('GET', `${API}/api/db/health`);
    expect(r.status === 200, `status ${r.status}`);
    expect(r.json?.ok === true, `db unreachable: ${r.text.slice(0, 120)}`);
    dbUp = true;
  }, { soft: true });

  await check('express', 'disallowed Origin gets no CORS allow header', async () => {
    const r = await http('GET', `${API}/api/health`, undefined, 15000).catch(() => null);
    // Re-request with a hostile Origin header
    const res = await fetch(`${API}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(!res.headers.get('access-control-allow-origin'), 'ACAO header present for hostile origin');
  });

  await check('express', 'Socket.IO handshake (polling) responds', async () => {
    const r = await http('GET', `${API}/socket.io/?EIO=4&transport=polling`);
    expect(r.status === 200, `status ${r.status}`);
    expect(r.text.startsWith('0{'), `unexpected handshake: ${r.text.slice(0, 40)}`);
  });
  return true;
}

// ── Validation gauntlet (our contract — all free, no external calls) ─────────

async function validationChecks() {
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
    ['POST /api/db/standups {} → 400', 'POST', `${API}/api/db/standups`, {}],
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

// ── Postgres roundtrip (own row only) ────────────────────────────────────────

async function dbChecks() {
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

// ── Jira (read-only, external dependency → soft) ─────────────────────────────

async function jiraChecks() {
  const healthy = await check('jira', 'GET /api/jira/health → connected', async () => {
    const r = await http('GET', `${API}/api/jira/health`, undefined, 20000);
    expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 120)}`);
    expect(r.json?.ok !== false, `not ok: ${r.text.slice(0, 120)}`);
  }, { soft: true });

  if (!healthy) {
    record('jira', 'GET /api/jira/sprints', 'SKIP', 'jira not connected');
    return;
  }
  await check('jira', 'GET /api/jira/sprints → array', async () => {
    const r = await http('GET', `${API}/api/jira/sprints`, undefined, 30000);
    // Known config dependency: without JIRA_BOARD_ID set, Jira returns 400
    // ("Jira API error: 400") — treated as WARN, not a regression.
    expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 120)}`);
    expect(Array.isArray(r.json), `not an array: ${r.text.slice(0, 80)}`);
    return `${r.json.length} sprint(s)`;
  }, { soft: true });
}

// ── Flask generator ──────────────────────────────────────────────────────────

async function flaskChecks() {
  const up = await check('flask', 'GET /api/health → 200', async () => {
    const r = await http('GET', `${FLASK}/api/health`);
    expect(r.status === 200, `status ${r.status}`);
  });
  if (!up) {
    record('flask', 'remaining Flask checks', 'SKIP', 'flask not reachable');
    return;
  }
  await check('flask', 'POST /api/generate short → 400 (validation, no Gemini)', async () => {
    const r = await http('POST', `${FLASK}/api/generate`, { description: 'x' });
    expect(r.status === 400, `expected 400, got ${r.status}`);
  });
  await check('flask', 'POST /api/classify {} → 400', async () => {
    const r = await http('POST', `${FLASK}/api/classify`, {});
    expect(r.status === 400, `expected 400, got ${r.status}`);
  });
}

// ── Standup bot (optional service → soft) ────────────────────────────────────

async function botChecks() {
  const up = await check('bot', 'GET /api/health → 200 running', async () => {
    const r = await http('GET', `${BOT}/api/health`, undefined, 8000);
    expect(r.status === 200 && r.json?.status === 'running', `status ${r.status}`);
  }, { soft: true });
  if (!up) {
    record('bot', 'GET /api/standup/history', 'SKIP', 'bot not running (optional)');
    return;
  }
  await check('bot', 'GET /api/standup/history → success', async () => {
    // Filter by a nonexistent project key: exercises route + DB read without
    // triggering the per-entry Slack display-name enrichment (N+1 API calls).
    const r = await http('GET', `${BOT}/api/standup/history?project_key=SMOKE-NONE`, undefined, 20000);
    expect(r.status === 200 && r.json?.success === true, `status ${r.status}: ${r.text.slice(0, 80)}`);
    return `${r.json.standups?.length ?? 0} standup(s) for filter`;
  }, { soft: true });
}

// ── Frontend dev server (optional) ───────────────────────────────────────────

async function frontendChecks() {
  try {
    const r = await http('GET', `${FRONTEND}/`, undefined, 8000);
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

console.log(`\nFocus Flow smoke tests — ${API}\n${'─'.repeat(60)}`);
const expressUp = await expressChecks();
if (expressUp) {
  await validationChecks();
  await dbChecks();
  await jiraChecks();
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
