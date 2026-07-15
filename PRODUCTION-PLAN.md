# Focus Flow — Production / SaaS Migration Plan

**Version:** 1.0 · **Date:** 2026-07-14 · **Repo:** `integration/` (git root)
**Goal:** Take Focus Flow from a localhost demo to a multi-tenant SaaS where each client organization connects **their own Jira + GitHub**, with real accounts, Postgres persistence, and hardened services.

---

## Roles & Protocol

| Role | Model | Responsibility |
|---|---|---|
| **Executor** | Opus | Implements steps in order, self-checks, marks `[x]`, appends to Execution Log |
| **Verifier** | Fable | Independently runs each step's **Verify** block, marks `[✓]`/`[✗]` + evidence in Verification Log |
| **User** | human | Steps flagged **USER-ACTION** (secret rotation, Clerk account); final decisions |

### Status markers (edit the checkbox in each step heading)
- `[ ]` pending · `[~]` in progress · `[x]` implemented (Opus) · `[✓]` verified (Fable) · `[✗]` failed verification (Fable adds notes; Opus must fix before ANY later step)

### Executor rules (Opus — read before starting)
1. Execute steps **strictly in order** within a phase. Do not start a phase before the previous phase's **Gate** is `[✓]`.
2. **Read every file before editing it.** Line numbers in this plan are as of 2026-07-14 and may drift — re-locate by content (grep), not by line number.
3. One step = one commit. Message format: `p<phase>.<step>: <summary>` (e.g. `p0.3: harden flask server config`). Follow the repo auto-commit policy in `.claude/CLAUDE.md` (commit + push after successful builds).
4. In the same commit, update this file: set the step's checkbox to `[x]` and append one line to the **Execution Log**.
5. **Never commit a secret.** No token, password, or key material in any tracked file — including this one. Refer to secrets by env-var name only.
6. On a **USER-ACTION** step: stop, tell the user exactly what to do, and wait for confirmation. Do not skip ahead past it if later steps depend on it.
7. Frontend conventions from `.claude/CLAUDE.md` still apply (Tailwind semantic utilities, no nested CSS in PostCSS, lucide-react icons, light theme default).
8. Backend/Flask/bot: preserve existing API contracts unless a step explicitly changes them. When a step changes a contract, it lists every consumer to update.
9. After each step: run the relevant build/smoke check listed in the step **before** committing.
10. **Regression harness** (see section below + TESTING.md): run the four unit suites and `node smoke-test.mjs` before marking any step `[x]`. A failing check is either a regression (fix it) or a deliberate contract change (update the affected tests **in the same commit** and note it in the Execution Log). Never leave the harness red between steps.

### Verifier rules (Fable)
1. Verify only steps marked `[x]`, in order.
2. Run the step's **Verify** block literally; do not trust the Execution Log claim — reproduce it.
3. Record `[✓]` or `[✗]` + one-line evidence in the **Verification Log**. On `[✗]`, write what failed and what you observed; Opus fixes before proceeding.
4. At each **Phase Gate**, run the whole gate checklist end-to-end, not per-step spot checks.
5. At each **Phase Gate**, also run the full regression harness (below) and record the counts.

### Regression harness (baseline 2026-07-14 — all green; details in TESTING.md)
| Suite | Command (repo root) | Baseline |
|---|---|---|
| Backend unit | `cd epic-dev-assignment/backend && npm test` | 26/26 |
| Frontend unit | `cd epic-dev-assignment/frontend && npm test` | 18/18 |
| Flask unit | `cd epic-generator && venv/Scripts/python.exe -m unittest discover -s tests` | 21/21 |
| Bot unit | `cd standup-bot && .venv/Scripts/python.exe -m unittest discover -s tests` | 9/9 |
| Smoke (live stack) | `node smoke-test.mjs [--ai]` | 25 PASS / 0 FAIL |

Smoke is safe by construction: no Jira writes (only the pre-Jira 400 path of sync), no bot `/test/*` routes, read-only Jira GETs, own-row-only DB roundtrip, AI generation gated behind `--ai`. When starting the bot only for smoke, run it with `SLACK_BOT_TOKEN='xoxb-smoke-invalid'` until Step 0.4 lands.

---

## Current State (audited 2026-07-14)

```
Frontend (React 19 + Vite)  :5173  — relative /api/* via dev-only Vite proxy
Express API gateway         :3003  — routes: epics, developers, assignment, jira, sync, standup, db + Socket.IO + node-cron
Flask epic-generator        :5000  — Gemini generation (/api/generate, /regenerate, /classify)
Slack standup-bot (Flask)   :3000  — slash command, DM reminders, Jira ticket automation, APScheduler
PostgreSQL "focusflow"             — tables: projects, developers, standups, retrospectives, assignments (EXISTS but frontend doesn't use it)
```

### Critical audit findings this plan fixes
| # | Finding | Where |
|---|---|---|
| A1 | **Zero authentication** on all Express `/api/*` incl. DELETEs, Jira project creation, email invites | `server.js:35-41`, `routes/db.js`, `routes/sync.js` |
| A2 | **Live secrets on disk** (GitHub PAT, Jira token, Slack token, Gemini key, DB password); DB password also **hardcoded in source & git history** (commit `cdd635f`) | `backend/.env`, `epic-generator/.env`, `standup-bot/.env`, `backend/db.js:5-6` |
| A3 | **Flask dev server with `debug=True, host=0.0.0.0`** → Werkzeug console = RCE if exposed | `epic-generator/web_app.py:870` |
| A4 | Standup bot: **no Slack signature verification**; open `/test/*` mass-DM routes; **reminder fires every 2 min** (left-in test value) | `standup-bot/app.py:556,589,651,1003-1054` |
| A5 | Frontend **hardwired to localhost**: dev-only Vite proxy for `/api`, hardcoded `io('http://localhost:3003')`, zero `VITE_*` env usage | `vite.config.js:9-15`, `src/hooks/useRealtime.js:6-12` |
| A6 | **All domain data in localStorage only** (`focus-flow-projects`, `focus-flow-developers`, …) — Postgres API exists but unused | `src/hooks/useProjects.jsx`, `useDevelopers.js`, `useRetro.js` |
| A7 | Client-side fake login `admin/1234`, printed on the login screen | `src/context/AuthContext.jsx:12-19`, `src/pages/Login.jsx:83-85` |
| A8 | Error messages leak internals (`err.message` → client) everywhere; no global error handler; no process guards; `trust proxy` unset; 50 MB JSON body limit | `server.js:32`, `routes/*.js` |
| A9 | Single-tenant integrations: `JIRA_*`/`GITHUB_TOKEN` are **global env vars** — incompatible with SaaS | `services/jiraService.js`, `services/githubService.js` |
| A10 | No DB SSL option; migration runner has no tracking table/transactions; cron unsafe for multi-instance | `db.js:8-13`, `scripts/migrate.js`, `server.js:83-89` |

---

## Locked Decisions

| ID | Decision | Rationale / revisit condition |
|---|---|---|
| **D1** | **Per-org integrations = client-pasted API tokens, envelope-encrypted at rest.** Atlassian OAuth 3LO + GitHub App is a Phase-4 fast-follow behind a `credentialProvider` abstraction so the swap doesn't touch call sites. | Reuses ~90% of working Jira/GitHub code (Basic auth). Revisit when: first paying customers, or a security review demands OAuth. Pre-req for OAuth: spike whether 3LO scopes allow **project creation** (core feature). |
| **D2** | **Accounts/orgs = Clerk** (`@clerk/clerk-react` + `@clerk/express`). Clerk owns identity, orgs, invites, roles; our Postgres stores domain data keyed by Clerk `orgId`. | Org-centric B2B is exactly Clerk's first-class feature. Revisit if per-MAU cost becomes material → Supabase Auth migration. |
| **D3** | **Hosting: deferred.** Everything stays host-agnostic: all config via env vars, no hardcoded origins, Dockerfiles provided in Phase 3. | Decide at Phase 3 (options: Vercel + Railway/Render + managed PG, or single VPS + compose + nginx). |
| **D4** | **Persistence = existing Postgres via `/api/db/*`**, org-scoped. localStorage remains only for: theme, in-progress wizard drafts, templates. | User-selected. |
| **D5** | **Gemini key stays platform-owned** (one key, our cost) — AI generation is the product. Per-org quotas = Phase 4 (billing). | |
| **D6** | **Standup bot stays single-workspace per deployment in v1** (its own env: Slack token + one org binding). Multi-workspace Slack OAuth = Phase 4. | Making the bot multi-tenant requires Slack app distribution + per-workspace token storage — separate project. |

## Target Architecture (end of Phase 2)

```
Browser ── Clerk (signup/login/org switcher, JWT)
   │  Authorization: Bearer <Clerk JWT>            VITE_API_URL / VITE_SOCKET_URL
   ▼
Express :3003 ── clerkMiddleware → requireOrg (401/403) ── org_id scoping on EVERY query
   │        │
   │        ├── credentialProvider(orgId) ── org_integrations (AES-256-GCM envelope) ── per-org Jira/GitHub creds
   │        ├── jiraClientFor(orgId) / githubClientFor(orgId)   ← NO global JIRA_*/GITHUB_TOKEN
   │        ├── Socket.IO (JWT handshake auth, org-checked rooms)
   │        └── X-Internal-Key ↔ Flask & standup-bot (server-to-server, never public)
   ▼
Postgres: projects/developers/standups/retrospectives/assignments (+ org_id NOT NULL) + org_integrations
Flask :5000 (gunicorn/waitress, debug OFF, internal-key gated)
Standup bot :3000 (Slack signature verified, internal-key to Express, daily reminders)
```

---

# PHASE 0 — Make the current codebase safe
*No feature changes. Everything here is prerequisite hygiene regardless of later phases.*

### Step 0.0 — Commit current WIP `[✓]`
**Size:** S · **Owner:** Opus
**Why:** Working tree has good uncommitted work (shared description validator + standup ticket-extraction safety net). Start from a clean tree.
**Files:** `epic-dev-assignment/backend/routes/epics.js`, `frontend/src/components/steps/Step1_EpicGeneration.jsx`, `frontend/src/utils/descriptionValidator.js` (new), `epic-generator/web_app.py`, `standup-bot/app.py`
**Spec:**
- `cd epic-dev-assignment/frontend && npm run build` — must exit 0.
- `python -m py_compile epic-generator/web_app.py standup-bot/app.py` — must exit 0.
- Commit all five files: `p0.0: description validation across all 3 layers + standup ticket extraction safety net`. Push.
**Accept:** `git status` clean (ignoring untracked non-source files); build passed.
**Verify (Fable):** `git log -1 --stat` shows the 5 files; `git status --short` empty; `cd frontend && npm run build` exits 0.

### Step 0.1 — Rotate ALL leaked secrets `[x]` **USER-ACTION**
**Size:** S (user) · **Owner:** USER (Opus guides + verifies hygiene)
**Why:** A2. Live GitHub PAT, Jira API token, Slack bot token, Gemini key sit in `.env` files; DB password is in **public git history** via `db.js`. The standup bot was exposed via a public ngrok tunnel. Treat all five as compromised.
**Spec (user does, Opus provides this checklist):**
1. GitHub PAT → revoke at github.com/settings/tokens, create new (repo read scope), update `backend/.env GITHUB_TOKEN`.
2. Jira API token → revoke at id.atlassian.com/manage-profile/security/api-tokens, create new, update `backend/.env JIRA_API_TOKEN` **and** `standup-bot/.env JIRA_API_TOKEN`.
3. Slack bot token → regenerate (api.slack.com/apps → OAuth), update `standup-bot/.env SLACK_BOT_TOKEN`. Also copy the app's **Signing Secret** → new `standup-bot/.env SLACK_SIGNING_SECRET` (needed by Step 0.4).
4. Gemini key → delete + recreate at aistudio.google.com/api-keys, update `epic-generator/.env` **and** `standup-bot/.env`.
5. Postgres: `ALTER USER postgres WITH PASSWORD '<new>';` update `backend/.env DATABASE_URL`.
6. Kill any running ngrok tunnels.
**Opus additionally:** confirm repo visibility on github.com (if **public**, note in Execution Log that history contains the old DB password — old password must never be reused).
**Accept:** User confirms all 5 rotated; all services still start with new values.
**Verify (Fable):**
- `git log --all --oneline -- "**/.env"` → empty (never committed).
- `git grep -InE "ghp_[A-Za-z0-9]{20,}|ATATT[A-Za-z0-9_-]{20,}|xoxb-[0-9]|AIza[A-Za-z0-9_-]{10,}" -- ':!*.md'` → no matches in tracked files.
- User confirmation recorded in Execution Log.

### Step 0.2 — db.js: remove hardcoded credential, fail fast, SSL support `[x]`
**Size:** S · **Owner:** Opus
**Why:** A2, A10. `db.js:5-6` falls back to a credentialed connection string (real password, in git history).
**Files:** `epic-dev-assignment/backend/db.js`, `backend/.env.example`
**Spec:**
- Delete the fallback. If `process.env.DATABASE_URL` is unset: `console.error` a clear message and `process.exit(1)` at module load (the API is useless without a DB and silently mis-targeting localhost is worse).
- Add to the Pool config: `ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined` (comment: managed PG providers use self-signed chains; set `DATABASE_SSL=true` in prod).
- `.env.example`: add `DATABASE_SSL=false` with comment.
**Accept:** `git grep moizdanishmand25` → nothing; starting server without `DATABASE_URL` exits 1 with a clear message.
**Verify (Fable):** run `node -e "delete process.env.DATABASE_URL; import('./db.js')"` from `backend/` (with .env temporarily renamed or env cleared) → exit code 1, clear message; grep confirms no credential string anywhere tracked.

### Step 0.3 — Flask epic-generator hardening `[x]`
**Size:** M · **Owner:** Opus
**Why:** A3. `debug=True` + `0.0.0.0` = remote code execution; wide-open CORS; API-key prefix logged; raw `str(e)` to clients; single-threaded dev server for 60-120s Gemini calls.
**Files:** `epic-generator/web_app.py`, `epic-generator/requirements.txt`, `epic-generator/.env.example`
**Spec:**
1. Replace `app.run(debug=True, host='0.0.0.0', port=5000, use_reloader=True)` with env-driven: `FLASK_DEBUG` (default `false`), `HOST` (default `127.0.0.1`), `PORT` (default `5000`), no reloader unless debug.
2. Delete the API-key debug print (`web_app.py:89` — `print(f"[DEBUG] API Key loaded: {GEMINI_API_KEY[:25]}...")`).
3. CORS: `CORS(app, origins=...)` from `CORS_ORIGINS` env (comma-separated; default `http://localhost:3003,http://localhost:5173`). Flask is only ever called by Express — never expose it publicly.
4. **Internal auth:** if `INTERNAL_API_KEY` env is set, a `before_request` hook requires header `X-Internal-Key` to match on all `/api/*` except `/api/health` (401 otherwise). When unset (local dev), no check.
5. Error responses: replace every `'error': str(e)` in 500-paths with a generic `'error': 'Generation service error'` + `traceback` logged server-side (keep 400 validation messages as-is).
6. Add `waitress>=3.0` to requirements. Document at top of `web_app.py`: prod run = `waitress-serve --host=127.0.0.1 --port=5000 --threads=8 --channel-timeout=300 web_app:app` (Windows/Linux) or gunicorn equivalent on Linux (`gunicorn -w 2 --threads 4 -b 127.0.0.1:5000 --timeout 300 web_app:app`).
7. Update Express `services/flaskProxy.js` to send `X-Internal-Key: process.env.INTERNAL_API_KEY` header when set. Same for the Flask call in `routes/jira.js:42` if present.
8. `.env.example` (both epic-generator and backend): add `INTERNAL_API_KEY=`, `FLASK_DEBUG=false`, `HOST=127.0.0.1`, `CORS_ORIGINS=`.
**Accept:** `git grep -n "debug=True" epic-generator/` → nothing; generation still works end-to-end through the wizard locally.
**Verify (Fable):**
- grep: no `debug=True`, no `GEMINI_API_KEY[:` logging, `CORS(app)` now has origins.
- Start Flask + Express with `INTERNAL_API_KEY=testkey123` in both `.env`s; `curl -s -X POST localhost:5000/api/generate -H "Content-Type: application/json" -d '{"description":"..."}' ` **without** the header → 401; via Express `/api/generate` → succeeds (200/400-validation, not 401).

### Step 0.4 — Standup bot hardening `[x]`
**Size:** M · **Owner:** Opus
**Why:** A4. Anyone can forge Slack requests (no signature check), trigger mass DMs via `/test/*`, dump standup history; reminders fire **every 2 minutes** (left-in test value).
**Files:** `standup-bot/app.py`, `standup-bot/.env.example`
**Spec:**
1. **Slack signature verification:** use `slack_sdk.signature.SignatureVerifier` with `SLACK_SIGNING_SECRET`. In a `before_request` hook for paths starting `/slack/`: verify `X-Slack-Signature` + `X-Slack-Request-Timestamp` against raw body (`request.get_data()`); 401 on failure. If the env var is unset: log a startup **warning** and (only when `FLASK_DEBUG=true`) allow — in non-debug mode, refuse to start without it.
2. **Reminder cadence:** replace `scheduler.add_job(send_standup_reminder, "interval", minutes=2)` with a `CronTrigger(hour=int(os.environ.get("REMINDER_HOUR", 9)), minute=int(os.environ.get("REMINDER_MINUTE", 30)))` daily job. Delete the `# TEMP` comment.
3. **Gate `/test/*` routes** (`/test/reminder`, `/test/followup`, `/test/stale`): require header `X-Admin-Key == ADMIN_API_KEY` env; if env unset → 404.
4. **Gate `/api/standup` + `/api/standup/history`:** require `X-Internal-Key == INTERNAL_API_KEY` (these are only called server-to-server by Express `routes/standup.js`). Update Express `routes/standup.js` to send the header.
5. Harden `/slack/events` parsing: wrap `json.loads(request.form.get("payload"))` in try/except + null check → 400 on malformed.
6. `app.run(port=3000)` → env-driven `HOST` (default `127.0.0.1`) / `PORT` (default 3000); add `waitress` to requirements with documented prod command.
7. `standup_data.json` path: resolve relative to `os.path.dirname(os.path.abspath(__file__))`, not CWD.
8. `.env.example`: add `SLACK_SIGNING_SECRET=`, `ADMIN_API_KEY=`, `INTERNAL_API_KEY=`, `REMINDER_HOUR=9`, `REMINDER_MINUTE=30`.
**Accept:** bot starts; forged POST to `/slack/events` without valid signature → 401; `/test/reminder` without admin key → 404; scheduler shows one daily cron job.
**Verify (Fable):**
- `python -m py_compile standup-bot/app.py`.
- grep: no `minutes=2`, `SignatureVerifier` present, `/test/` handlers check admin key.
- `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/slack/events -d "payload={}"` → `401`; `curl .../test/reminder` → `404` (no key set) — run with bot started locally.

### Step 0.5 — Express server hardening `[x]`
**Size:** M · **Owner:** Opus
**Why:** A8, A10. No global error handler, no process guards, `trust proxy` unset, 50 MB body limit, CORS callback throws 500s, no graceful shutdown, cron double-fires on multi-instance.
**Files:** `epic-dev-assignment/backend/server.js`, `backend/.env.example`
**Spec:**
1. `app.set('trust proxy', Number(process.env.TRUST_PROXY || 0))` — comment: set `TRUST_PROXY=1` behind a reverse proxy/load balancer.
2. `express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' })`.
3. **Global rate limit** on `/api`: `express-rate-limit`, `windowMs: 15min`, `max: Number(process.env.RATE_LIMIT_MAX || 300)`, standard headers; keep the stricter `aiLimiter` in epics.js.
4. CORS origin callback: on disallowed origin call `cb(null, false)` (no throw → no 500).
5. **Global error middleware** (last): log full error server-side; respond `{ success:false, error: err.expose ? err.message : 'Internal server error' }` with `err.status || 500`.
6. `process.on('unhandledRejection', log)`; `process.on('uncaughtException', log + process.exit(1))`.
7. **Graceful shutdown:** on SIGTERM/SIGINT → `httpServer.close()`, `io.close()`, `pool.end()`, exit 0 (force-exit after 10s timeout).
8. **Cron safety:** wrap the dev-refresh cron body in a Postgres advisory lock (`SELECT pg_try_advisory_lock(823471)` → skip run if false, `pg_advisory_unlock` in finally). Prevents N-instance double-fire.
9. Startup log: print the actual bind info, not hardcoded `localhost`.
**Accept:** server boots; `curl` an unknown-origin request → CORS-blocked without 500; hitting a route 301+ times in 15 min → 429.
**Verify (Fable):**
- grep server.js for: `trust proxy`, `JSON_BODY_LIMIT|2mb`, global `app.use((err`, `unhandledRejection`, `SIGTERM`, `pg_try_advisory_lock`.
- Start server; `for i in $(seq 1 320); do curl -s -o /dev/null localhost:3003/api/health; done` then one more → observe 429 (or confirm limiter excludes /api/health if implemented that way — limiter must cover `/api/db/*` at minimum).
- `curl -s -H "Origin: https://evil.example" -i localhost:3003/api/health | head -5` → no `Access-Control-Allow-Origin` header, status not 500.

### Step 0.6 — Stop leaking internal error details (sweep) `[x]`
**Size:** M · **Owner:** Opus
**Why:** A8. ~30 catch blocks return raw `err.message` (Postgres constraint names, driver errors) to clients.
**Files:** `backend/routes/db.js`, `routes/jira.js`, `routes/sync.js`, `routes/epics.js`, `routes/developers.js`, `routes/assignment.js`, `routes/standup.js`
**Spec:**
- Add `backend/utils/httpError.js`: `sendServerError(res, err, publicMessage = 'Internal server error')` → `console.error` full err, respond 500 `{ success:false, error: publicMessage }`.
- Sweep every `res.status(500).json({ error: err.message })`-style call → `sendServerError(res, err)`.
- **Keep**: 4xx validation messages, and Jira errors already passed through `parseJiraError()` (they're the user's own Jira feedback, needed by SyncButton warnings UI) — but confirm `parseJiraError` output never includes auth headers/tokens.
**Accept:** `git grep -n "err.message" backend/routes | grep 500` → no 500-path leaks remain.
**Verify (Fable):** grep as above; stop Postgres (or set bad `DATABASE_URL`), `curl localhost:3003/api/db/projects` → body is generic `Internal server error`, no pg details; server log has the real error.

### Step 0.7 — Frontend: env-driven API base + socket URL `[x]`
**Size:** M · **Owner:** Opus
**Why:** A5. Production build cannot reach any backend today: relative `/api/*` only works under the dev proxy; socket hardcodes `http://localhost:3003`.
**Files:** new `frontend/src/lib/api.js`, `frontend/src/hooks/useRealtime.js`, every fetch call site, new `frontend/.env.example`
**Spec:**
1. Create `src/lib/api.js`:
   ```js
   export const API_BASE = import.meta.env.VITE_API_URL || '';           // '' = same-origin (+ dev proxy)
   export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL
     || import.meta.env.VITE_API_URL
     || (import.meta.env.DEV ? 'http://localhost:3003' : window.location.origin);
   export function apiUrl(path) { return `${API_BASE}${path}`; }
   export async function apiFetch(path, opts) { return fetch(apiUrl(path), opts); }
   ```
2. Sweep **all** direct `fetch('/api/...')` call sites → `apiFetch('/api/...')`. Known sites (re-grep `fetch\(['\`]/api` to be exhaustive): `context/WorkflowContext.jsx` (×4), `components/steps/Step1_EpicGeneration.jsx`, `Step3_DeveloperAnalysis.jsx`, `Step4_Assignment.jsx`, `pages/projects/AssignPage.jsx` (×3), `pages/DevelopersPage.jsx` (×2), `components/projects/SyncButton.jsx`, `pages/projects/ProjectWizardPage.jsx`, `pages/projects/ProjectDetailPage.jsx` (×2), `pages/jira/Dashboard.jsx`, `hooks/useSprintCompletion.js`.
3. SWR hooks (`useSprintData.js`, `useKanbanSync.js`): keep the `/api/...` strings as SWR keys, but route the **fetcher** through `apiFetch` (key stays stable, request goes to `API_BASE`).
4. `useRealtime.js`: `io(SOCKET_URL, { transports: ['websocket'], autoConnect: true })`.
5. Add `frontend/.env.example`: `VITE_API_URL=` and `VITE_SOCKET_URL=` with comments (empty = same-origin; set to `https://api.yourdomain.com` on split hosting). Note in file: **anything `VITE_`-prefixed is public** — never put secrets here.
**Accept:** `npm run build` passes; `grep -r "localhost:3003" dist/assets/*.js` → **zero** matches (the dev fallback is tree-shaken out of prod builds because `import.meta.env.DEV` is statically false).
**Verify (Fable):** run the grep on a fresh build; `grep -rn "fetch('/api\|fetch(\`/api" src/` → no direct call sites remain outside `lib/api.js`; dev smoke: `npm run dev` + wizard generate still works.

### Step 0.8 — Migration runner: tracking table + transactions `[ ]`
**Size:** S · **Owner:** Opus
**Why:** A10. Runner re-applies all files every run, no transaction — a future non-idempotent migration double-applies or half-applies.
**Files:** `backend/scripts/migrate.js`, `backend/package.json`
**Spec:**
- Create `schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())` if missing.
- For each `migrations/*.sql` sorted: skip if recorded; else `BEGIN` → run file → `INSERT INTO schema_migrations` → `COMMIT` (rollback + abort on error, log which file failed).
- `package.json`: add `"migrate": "node scripts/migrate.js"`.
**Accept:** running `npm run migrate` twice in a row: first run applies pending, second prints "0 pending".
**Verify (Fable):** run twice, observe idempotency; `SELECT * FROM schema_migrations` lists `001_init.sql`.

### Step 0.9 — Portability + env-example sweep `[ ]`
**Size:** S · **Owner:** Opus
**Why:** Machine-specific path in `scripts/import-standups.js:6`; `.env.example` files must document every env var Phase 0 introduced.
**Files:** `backend/scripts/import-standups.js`, all four `.env.example` files, `README.md`
**Spec:**
- `import-standups.js`: take the JSON path as `process.argv[2]`, default `../../standup-bot/standup_data.json` resolved from the script dir; remove the `c:/Users/user/...` literal.
- Reconcile all `.env.example`s against the **Appendix A env matrix** (Phase-0 rows).
- README: add a short "Production notes" section pointing at this plan.
**Accept:** `git grep -n "c:/Users\|C:\\\\Users" -- ':!*.md'` → nothing tracked.
**Verify (Fable):** grep passes; each `.env.example` contains every Phase-0 var from Appendix A.

### 🚧 GATE G0 — Phase 0 complete `[ ]`
**Fable runs all of:**
1. All Phase-0 steps `[✓]`.
2. Full local stack boots (Flask via waitress, Express, bot, `npm run dev`) with new env vars; wizard generate → approve → analyze → assign → **Save Without Jira** works.
3. Secret scan: `git grep -InE "ghp_|ATATT|xoxb-|AIza|moizdanishmand" -- ':!PRODUCTION-PLAN.md'` → clean; `git log --all -- "**/.env"` → empty.
4. `npm run build` (frontend) exits 0; no `localhost` strings in `dist/assets/*.js`.
5. Forged-request checks from 0.3/0.4 all return 401/404.
6. Regression harness fully green with Phase-0-updated expectations (unit suites + `node smoke-test.mjs`; e.g. Flask/bot internal-key 401 checks added, CORS behavior re-pinned).

---

# PHASE 1 — Accounts, organizations, tenancy, Postgres persistence
*Clerk for identity/orgs; every row and every query gains `org_id`; frontend moves from localStorage to the DB.*

### Step 1.1 — Clerk application setup `[ ]` **USER-ACTION**
**Size:** S · **Owner:** USER (Opus guides)
**Spec (user):** Create app at dashboard.clerk.com → enable **Organizations** (Settings → Organizations) → copy `CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (dev instance) → give to Opus for `.env` placement (`frontend/.env.local`: `VITE_CLERK_PUBLISHABLE_KEY`; `backend/.env`: `CLERK_SECRET_KEY`).
**Accept:** Keys present locally (never committed); Clerk dashboard shows Organizations enabled.
**Verify (Fable):** `.env.example`s updated with empty placeholders; `git grep "pk_live\|pk_test\|sk_live\|sk_test"` → nothing tracked.

### Step 1.2 — Frontend: ClerkProvider, sign-in, org gating `[ ]`
**Size:** M · **Owner:** Opus
**Why:** A7 — replace fake `admin/1234` client-side auth.
**Files:** `frontend/src/main.jsx` or `App.jsx`, `src/pages/Login.jsx`, `src/components/layout/AuthGuard.jsx`, `src/components/layout/Header.jsx`, `package.json`
**Spec:**
1. `npm i @clerk/clerk-react`. Wrap the router in `<ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>` (fail fast with a clear screen if the key is missing).
2. `/login` route → Clerk `<SignIn />` (styled to match theme); add `/signup` → `<SignUp />`.
3. `AuthGuard` → `<SignedIn>{children}</SignedIn><SignedOut><RedirectToSignIn/></SignedOut>`, **plus org gate**: if signed in but no active organization, render a centered `<CreateOrganization />` + `<OrganizationList />` panel ("Create or select your organization") instead of the app.
4. Header: add `<OrganizationSwitcher />` + `<UserButton />`; remove the old logout that clears sessionStorage.
5. Do **not** delete `AuthContext.jsx` yet (Step 1.8 does the cleanup after everything else migrates).
**Accept:** Fresh browser → redirected to Clerk sign-in; after signup + org creation → app renders; hard refresh stays signed in.
**Verify (Fable):** manual flow above; `grep -rn "admin' \|'1234'" src/` still present only in files scheduled for deletion in 1.8; build passes.

### Step 1.3 — Frontend: authenticated API layer + socket auth `[ ]`
**Size:** M · **Owner:** Opus
**Files:** `frontend/src/lib/api.js`, new `src/lib/AuthBridge.jsx`, `src/hooks/useRealtime.js`, SWR fetchers
**Spec:**
1. In `lib/api.js` add a module-level token getter: `let tokenGetter = null; export function setTokenGetter(fn){tokenGetter = fn}`. `apiFetch` becomes: get token (`await tokenGetter?.()`), attach `Authorization: Bearer <token>` when present, then fetch. On 401 response → `window.dispatchEvent(new Event('auth:expired'))`.
2. `AuthBridge.jsx` (rendered once inside ClerkProvider): `const { getToken } = useAuth(); useEffect(() => setTokenGetter(() => getToken()), [getToken])`.
3. All SWR fetchers already flow through `apiFetch` (0.7) — confirm none bypass it.
4. Socket: connect with `auth: { token: await tokenGetter() }`; reconnect logic refreshes the token (`socket.auth.token = ...` before reconnect attempts).
**Accept:** Network tab shows `Authorization: Bearer` on every `/api/*` request when signed in.
**Verify (Fable):** devtools check; sign out → API calls stop (guard redirects); no fetch site imports raw `fetch` for `/api` paths (`grep`).

### Step 1.4 — Backend: Clerk middleware, org enforcement, socket auth, internal-auth path `[ ]`
**Size:** L · **Owner:** Opus
**Why:** A1 — this is the step that actually closes the open API.
**Files:** `backend/server.js`, new `backend/middleware/auth.js`, `backend/routes/*.js`, `backend/io.js`, `package.json`
**Spec:**
1. `npm i @clerk/express @clerk/backend`. `app.use(clerkMiddleware())` before routers.
2. `middleware/auth.js`:
   - `requireOrg(req,res,next)`: `const { userId, orgId, orgRole } = getAuth(req)`; 401 if no `userId`, 403 `{error:'NO_ACTIVE_ORG'}` if no `orgId`; set `req.userId/req.orgId/req.orgRole`.
   - `internalOnly(req,res,next)`: 401 unless `req.get('X-Internal-Key') === process.env.INTERNAL_API_KEY` (and env set).
   - `orgOrInternal`: pass if either applies; for internal callers take `org_id` from `req.get('X-Org-Id')` (bot's binding, D6) — set `req.orgId` from it.
3. Apply: `requireOrg` on ALL `/api` routers **except**: `/api/health` (open), `/api/db/standups` POST + `/api/standup/*` proxy (use `orgOrInternal`).
4. Socket.IO: `io.use()` handshake middleware — `verifyToken(handshake.auth.token, { secretKey })` from `@clerk/backend`; attach `socket.orgId` (from token org claim); reject without valid token. `join` handler: only join `project:<KEY>` after `SELECT 1 FROM projects WHERE jira_key-or-id maps AND org_id = socket.orgId` (read the actual projects schema first; match on the stored Jira project key field used by `emitToProject`).
5. Express `routes/standup.js` proxy → bot: keep sending `X-Internal-Key` (0.4); bot's inbound posts to Express include `X-Internal-Key` + `X-Org-Id: process.env.STANDUP_ORG_ID` — add `STANDUP_ORG_ID` to bot `.env.example`; bot reads it and sends the header (small bot edit).
6. `.env.example` backend: `CLERK_SECRET_KEY=`, note `INTERNAL_API_KEY` shared with Flask/bot.
**Accept:** Unauthed `curl localhost:3003/api/db/projects` → 401. Signed-in browser works. Bot can still POST standups with internal key + org id.
**Verify (Fable):**
- `curl -s -o /dev/null -w "%{http_code}" localhost:3003/api/db/projects` → 401; same for `/api/generate`, `/api/jira/sprints`, `DELETE /api/db/projects/x` → 401.
- `curl -s -o /dev/null -w "%{http_code}" localhost:3003/api/health` → 200.
- With `X-Internal-Key` + `X-Org-Id`: POST `/api/db/standups` → 2xx.
- Socket: `node -e` quick client without token → `connect_error`.

### Step 1.5 — DB migration 002: org_id columns (+ backfill script) `[ ]`
**Size:** M · **Owner:** Opus
**Why:** A6/A1 — tenancy at the data layer.
**Files:** new `backend/migrations/002_org_tenancy.sql`, new `backend/scripts/backfill-org.js`
**Spec:**
1. **First read `migrations/001_init.sql`** to confirm exact tables/columns.
2. `002_org_tenancy.sql`: `ALTER TABLE <projects|developers|standups|retrospectives|assignments> ADD COLUMN IF NOT EXISTS org_id TEXT;` + `CREATE INDEX IF NOT EXISTS idx_<t>_org ON <t>(org_id);` for each. (Nullable for now — legacy rows.) If `projects` lacks a JSONB payload column able to hold the full frontend project object, add `data JSONB` here too (check `routes/db.js` POST /projects contract first).
3. `scripts/backfill-org.js <orgId>`: `UPDATE <each table> SET org_id = $1 WHERE org_id IS NULL`; prints per-table counts. (User runs it with their real Clerk org id to claim existing local data.)
4. Run `npm run migrate`.
**Accept:** `\d projects` shows `org_id`; migrate idempotent.
**Verify (Fable):** `node -e` query `information_schema.columns` for org_id on all 5 tables; `npm run migrate` again → 0 pending.

### Step 1.6 — Backend: org-scope every DB query; migration 003 enforces NOT NULL `[ ]`
**Size:** L · **Owner:** Opus
**Files:** `backend/routes/db.js`, new `backend/migrations/003_org_enforce.sql`
**Spec:**
1. Every query in `routes/db.js` gains org scoping from `req.orgId`:
   - Lists: `WHERE org_id = $1`. Single-row GET/DELETE: `WHERE id = $1 AND org_id = $2` (DELETE returns 404 when 0 rows).
   - INSERT/UPSERT: set `org_id`. Developers upsert conflict target becomes `(org_id, username)`.
   - Bulk assignments: org_id on every row; verify the referenced `project_id` belongs to `req.orgId` first (403 otherwise).
   - Standups POST (internal path): org from `req.orgId` set by `orgOrInternal`.
2. `003_org_enforce.sql` (run **after** user backfills):
   - `ALTER TABLE ... ALTER COLUMN org_id SET NOT NULL;` all 5 tables.
   - developers PK: `ALTER TABLE developers DROP CONSTRAINT developers_pkey; ALTER TABLE developers ADD PRIMARY KEY (org_id, username);` — first check nothing FK-references `developers(username)` (001 review from 1.5).
3. `services/developerRefresher.js`: iterate developers **per org** (`SELECT DISTINCT org_id FROM developers`), preserving current behavior otherwise (per-org tokens arrive in Phase 2).
**Accept:** Two different Clerk orgs see fully disjoint data (manual two-account test); DELETE on another org's project id → 404.
**Verify (Fable):**
- Code review: every SQL string in db.js references org_id (grep `FROM projects|developers|standups|retrospectives|assignments` and inspect each).
- **Isolation test:** create org A and org B (two browsers/users); A creates a project; B's `/api/db/projects` → `[]`; B `DELETE` A's project id → 404 and A's row survives.

### Step 1.7 — Frontend: swap localStorage hooks to Postgres-backed SWR `[ ]`
**Size:** L · **Owner:** Opus
**Why:** A6, D4 — data must survive browsers and be shared org-wide.
**Files:** `frontend/src/hooks/useProjects.jsx`, `useDevelopers.js`, `useRetro.js`; touch-points listed below
**Spec:**
1. **Read `routes/db.js` first** and mirror its request/response contracts exactly.
2. Rewrite `useProjects` **preserving its exported interface** (`projects, addProject, updateProject, deleteProject, getProject`, etc. — read current file for the exact surface): internally SWR `GET /api/db/projects`, mutations POST/PUT/DELETE via `apiFetch`, optimistic `mutate` for snappy UI. Same for `useDevelopers` (`/api/db/developers`) and `useRetro` (`/api/db/retrospectives`).
3. Async reality: `addProject` callers (ProjectWizardPage `handleSync`/`handleSaveOnly`, ProjectsPage) must await the POST; add error toasts on failure (use existing notify util).
4. Keep localStorage ONLY for: `theme*`, `epic-workflow-state` (in-progress wizard drafts), `focus-flow-templates` (per D4 note).
5. **One-time import (optional but recommended):** on ProjectsPage, if server list is empty AND `localStorage['focus-flow-projects']` is non-empty → banner "Import N locally saved projects into your organization" → POSTs each, then renames the key to `focus-flow-projects.migrated`.
6. Update any component that reads those localStorage keys directly (grep `focus-flow-projects|focus-flow-developers|focus-flow-retros` across src/).
**Accept:** Create project → visible after hard refresh AND from a second browser signed into the same org; DB row exists; localStorage no longer holds the canonical copy.
**Verify (Fable):**
- Manual: wizard → save → `SELECT id, name, org_id FROM projects` shows the row with correct org.
- Clear site data → reload → projects still listed.
- grep: no `localStorage.setItem('focus-flow-projects'` outside the import shim.

### Step 1.8 — Remove legacy auth artifacts `[ ]`
**Size:** S · **Owner:** Opus
**Files:** delete `src/context/AuthContext.jsx`; purge remnants in `Login.jsx` (if replaced wholesale, delete), Header, App.jsx imports
**Spec:** Remove AuthContext + hardcoded credentials + "Default credentials: admin / 1234" copy + `focus-flow-auth` sessionStorage usage. Fix all imports; build must pass.
**Accept:** `git grep -n "focus-flow-auth\|admin.*1234"` → nothing; build passes.
**Verify (Fable):** greps + `npm run build`; signed-out user cannot render any app route (manual).

### 🚧 GATE G1 — Phase 1 complete `[ ]`
1. All Phase-1 steps `[✓]`.
2. **End-to-end:** fresh incognito → sign up → create org → wizard: generate epics → approve → analyze devs → assign → Save (without Jira) → project visible in DB and after refresh → second member invited via Clerk sees the same project; a **different** org sees nothing (full isolation matrix from 1.6 re-run).
3. Every `/api/*` (minus health + internal paths) returns 401 unauthenticated — scripted curl sweep over: generate, regenerate, classify-epics, analyze-developers, auto-assign, reassign, all `/api/db/*`, all `/api/jira/*`, sync-jira.
4. Socket connects only with a valid token; cross-org room join rejected.
5. `npm run build` clean.
6. Regression harness green with Phase-1 expectations (smoke's open-access checks become 401 assertions; authed-request variants added with a test token).

---

# PHASE 2 — Per-tenant Jira & GitHub (the SaaS core)
*Kill global `JIRA_*`/`GITHUB_TOKEN`; each org connects its own credentials, envelope-encrypted; services take credentials per request via `credentialProvider`.*

### Step 2.1 — Migration 004: `org_integrations` `[ ]`
**Size:** S · **Owner:** Opus
**Files:** new `backend/migrations/004_org_integrations.sql`
**Spec:**
```sql
CREATE TABLE IF NOT EXISTS org_integrations (
  org_id      TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('jira','github')),
  ciphertext  TEXT NOT NULL,          -- envelope JSON (see 2.2), base64/JSON string
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);
```
**Verify (Fable):** migrate runs; table exists with composite PK.

### Step 2.2 — Envelope encryption service `[ ]`
**Size:** M · **Owner:** Opus
**Files:** new `backend/services/cryptoService.js`, `backend/.env.example`
**Spec:**
1. AES-256-GCM envelope: per-secret random 32-byte DEK encrypts the JSON payload; DEK is wrapped by the **master key** (`CREDENTIALS_MASTER_KEY`, base64 32 bytes, from env for v1). Stored blob: `{v:1, kv:<key_version>, dekIv, dekTag, dekCt, iv, tag, ct}` (all base64).
2. API: `encryptJson(obj) → string`, `decryptJson(string) → obj`. Master-key access isolated in two internal fns `wrapDek/unwrapDek` — the future KMS swap touches only those (leave a comment saying exactly that).
3. Fail fast at boot if `CREDENTIALS_MASTER_KEY` missing/malformed **when any integration route is mounted** (i.e., always in Phase 2+): clear error + exit.
4. Generation helper for the user: document `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` in `.env.example`.
5. Unit sanity script `scripts/crypto-selftest.js`: encrypt→decrypt round-trip + tamper detection (flip a byte → must throw).
**Verify (Fable):** `node scripts/crypto-selftest.js` passes; boot without master key → exit 1 clear message; DB rows (after 2.4) contain no plaintext (`SELECT ciphertext FROM org_integrations` — no `atlassian.net`, no `ghp_`).

### Step 2.3 — credentialProvider `[ ]`
**Size:** M · **Owner:** Opus
**Files:** new `backend/services/credentialProvider.js`
**Spec:**
- `getJiraCredentials(orgId) → {domain, email, apiToken} | null`; `getGithubToken(orgId) → string | null`; `setIntegration(orgId, provider, payloadObj)` (encrypt + upsert + cache-bust); `deleteIntegration(orgId, provider)`; `getStatus(orgId) → {jira:{connected, domain, email}, github:{connected, tokenSuffix}}` (**never** returns secrets — domain/email ok, token only last-4).
- In-memory TTL cache (5 min) keyed `orgId:provider`; invalidated on set/delete.
- Typed error: `IntegrationNotConnectedError(provider)` for downstream 412 mapping.
**Verify (Fable):** code review — no code path returns the decrypted token except `getJiraCredentials/getGithubToken` consumed by services; cache invalidation on set (write a 20-line script: set → get → set new → get returns new).

### Step 2.4 — Integrations API + admin gating `[ ]`
**Size:** M · **Owner:** Opus
**Files:** new `backend/routes/integrations.js`, mount in `server.js`
**Spec:**
- `GET /api/integrations` (requireOrg) → `getStatus(req.orgId)`.
- `PUT /api/integrations/jira` `{domain, email, apiToken}` — **org admin only** (`req.orgRole === 'org:admin'` else 403). Validate: domain matches `^[a-z0-9-]+\.atlassian\.net$` (strip protocol), email sane, token non-empty. **Test before save:** call Jira `/rest/api/3/myself` with the supplied creds; on failure → 400 with Jira's message; on success → `setIntegration` + return status.
- `PUT /api/integrations/github` `{token}` — admin only; test via `GET https://api.github.com/user` (+ store login for status display); save on success.
- `DELETE /api/integrations/:provider` — admin only.
- `POST /api/integrations/:provider/test` — re-run the validation against **stored** creds, return ok/error (for a "Test connection" button).
- Never log the token; redact request bodies for these routes in any logging.
**Verify (Fable):** as non-admin member → PUT → 403. PUT with garbage token → 400 (Jira 401 surfaced). PUT valid → GET shows `connected:true` + domain; DB ciphertext opaque; server logs show no token.

### Step 2.5 — jiraService → per-org client factory `[ ]`
**Size:** L · **Owner:** Opus (largest refactor — do it in one commit, all callers updated)
**Files:** `backend/services/jiraService.js`, `backend/routes/jira.js`, `backend/routes/sync.js`
**Spec:**
1. Refactor `jiraService.js` to `export function createJiraClient({domain, email, apiToken})` returning the existing functions bound to those creds (auth header + base URL from params instead of module-level env). Keep every function's signature/behavior otherwise — this is a mechanical closure-ization.
2. **Field-discovery cache** (`discoverFields`) becomes per-domain: `Map<domain, {fields, fetchedAt}>` (10-min TTL as today).
3. Add `backend/services/jiraClientFor.js` (or export from credentialProvider): `await jiraClientFor(orgId)` → creds via provider → `createJiraClient(creds)`; throws `IntegrationNotConnectedError('jira')`.
4. `routes/jira.js` + `routes/sync.js`: every handler obtains `const jira = await jiraClientFor(req.orgId)` and calls methods on it. Map `IntegrationNotConnectedError` → **412** `{success:false, error:'JIRA_NOT_CONNECTED'}` (add to the global error middleware or a small helper).
5. Remove all `process.env.JIRA_DOMAIN|JIRA_EMAIL|JIRA_API_TOKEN` reads from backend source. (`.env` cleanup in 2.8.)
**Accept:** With org's Jira connected: sync-jira, sprints, kanban transitions all work exactly as before. Without: Jira endpoints → 412.
**Verify (Fable):** `git grep -n "JIRA_DOMAIN\|JIRA_EMAIL\|JIRA_API_TOKEN" backend/ --include='*.js'` → only `.env.example` mentions remain pre-2.8; curl a Jira endpoint for an org with no integration → 412; full sync E2E against the (rotated) test Jira → project created, sprints, stories, invitations as per CLAUDE.md flow.

### Step 2.6 — githubService → per-org token; refresher per-org `[ ]`
**Size:** M · **Owner:** Opus
**Files:** `backend/services/githubService.js`, `backend/routes/developers.js`, `backend/services/developerRefresher.js`
**Spec:**
1. `githubService` functions take a `token` (or a `createGithubClient(token)` factory mirroring 2.5); remove `process.env.GITHUB_TOKEN` reads.
2. `routes/developers.js` (`/api/analyze-developers`): resolve token via provider; if not connected → **412** `{error:'GITHUB_NOT_CONNECTED'}` (unauthenticated GitHub = 60 req/hr — not viable; require connection).
3. `developerRefresher.js`: outer loop over orgs that have a github integration (`SELECT DISTINCT org_id …` join `org_integrations`); refresh that org's developers with that org's token; skip orgs without one (log once).
**Verify (Fable):** grep for `GITHUB_TOKEN` in backend src → gone; analyze-developers without connection → 412; with → works (manual, one username).

### Step 2.7 — Settings UI: Connect Jira / Connect GitHub `[ ]`
**Size:** L · **Owner:** Opus
**Files:** `frontend/src/pages/jira/Settings.jsx` (read first — repurpose), `src/lib/api.js` (412 handling), touch-points: `SyncButton.jsx`, `useSprintData.js`/`useKanbanSync.js` empty states, `AssignPage`/`Step3` (GitHub), `Dashboard.jsx`
**Spec:**
1. Settings page becomes **Integrations**: two cards (Jira, GitHub) — status badge (Connected as `you@x` on `acme.atlassian.net` / Not connected), inputs (Jira: domain, email, API token w/ link to id.atlassian.com token page; GitHub: PAT w/ scopes note `repo` read), buttons: Connect (PUT), Test, Disconnect (confirm dialog). Admin-only editing: non-admins see status + "Ask an org admin". Tokens are write-only (never displayed; placeholder `••••` when connected).
2. `apiFetch`: expose response handling so callers can detect 412 codes `JIRA_NOT_CONNECTED`/`GITHUB_NOT_CONNECTED` (e.g. throw typed error `{code}`).
3. Graceful not-connected UX: Dashboard/Kanban/Reports → centered empty state "Connect Jira to see sprint data" + button → `/settings`; SyncButton disabled with tooltip when Jira not connected (fetch status once via SWR `GET /api/integrations`); Step3/AssignPage analyze → inline notice when GitHub not connected.
4. Follow theme conventions (semantic utilities, light default).
**Accept:** New org: everything AI-side works; Jira/GitHub surfaces show connect CTAs, no red error spam. Connect Jira → dashboards light up.
**Verify (Fable):** manual walk of the matrix (no integrations / jira only / both); non-admin cannot save (403 surfaced politely); token never appears in any GET response or the DOM after save.

### Step 2.8 — Kill global integration env vars + docs `[ ]`
**Size:** S · **Owner:** Opus
**Files:** `backend/.env.example`, `backend/.env` (user's local), `README.md`, `.claude/CLAUDE.md`
**Spec:** Remove `JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_BOARD_ID/GITHUB_TOKEN` from backend `.env.example` (bot keeps its own per D6). Tell the user to delete them from local `.env` and instead connect via Settings UI. Update README + CLAUDE.md "Environment Variables" + add the per-org integrations model to CLAUDE.md architecture notes.
**Verify (Fable):** backend boots with those vars absent; grep `.env.example` — gone; CLAUDE.md updated.

### 🚧 GATE G2 — Phase 2 complete `[ ]`
1. All Phase-2 steps `[✓]`.
2. **Two-org integration isolation:** org A connects Jira-A, org B has none → A syncs a project into Jira-A successfully; B's Jira endpoints → 412; B cannot see A's integration status; DB `org_integrations` ciphertext opaque.
3. Full E2E on org A: wizard → assign → **Sync to Jira** → verify in Jira Cloud: project, board, sprints, stories w/ points + assignees, invited developer email (per CLAUDE.md sync flow).
4. Secret hygiene: server logs from the E2E contain no token material; `GET /api/integrations` responses contain no token.
5. Backend has zero reads of `JIRA_*`/`GITHUB_TOKEN` env.
6. Regression harness green with Phase-2 expectations (412 not-connected checks added for Jira/GitHub endpoints; crypto self-test in the unit run).

---

# PHASE 3 — Production infrastructure & launch
*Host-agnostic packaging, observability, runbook; hosting decision (D3) gets made here.*

### Step 3.1 — Dockerfiles + compose (prod parity) `[ ]`
**Size:** M · **Owner:** Opus
**Files:** new `epic-dev-assignment/backend/Dockerfile`, `epic-generator/Dockerfile`, `standup-bot/Dockerfile`, `epic-dev-assignment/frontend/Dockerfile` (build → nginx serve w/ SPA fallback + `/api` proxy example), root `docker-compose.prod.yml`, `.dockerignore`s
**Spec:** Node 22-alpine multi-stage for backend (npm ci --omit=dev, non-root user, `CMD node server.js`); python:3.12-slim + gunicorn for both Flask apps (non-root); frontend: build stage (accepts `VITE_*` build args) → nginx:alpine with `try_files $uri /index.html` + example `location /api` proxy. Compose wires: postgres:16 (volume), backend (depends_on pg, runs `npm run migrate` before start via entrypoint), flask, bot, frontend; all env via `env_file`; only frontend + backend ports exposed; flask/bot internal-only.
**Verify (Fable):** `docker compose -f docker-compose.prod.yml up --build` → full stack healthy; wizard E2E through `http://localhost:<frontend-port>`; flask/bot unreachable from host except via backend.

### Step 3.2 — Structured logging + request IDs `[ ]`
**Size:** M · **Owner:** Opus
**Files:** `backend/` (pino + pino-http), light-touch on Flask/bot (Python `logging` with level env)
**Spec:** `pino` logger module; `pino-http` with request-id generation (respect inbound `X-Request-Id`); replace `console.*` in server.js, db.js, middleware, and the hottest routes (sync.js, jira.js) with the logger (leave deep service `console.log`s as debug-level follow-up); redaction config for `authorization`, `apiToken`, `token` fields. Flask/bot: `LOG_LEVEL` env, timestamps, replace bare prints in request paths (keep it pragmatic).
**Verify (Fable):** logs are JSON lines with req ids; trigger a sync → one correlated id across its log lines; grep logs for token patterns during an integration save → nothing.

### Step 3.3 — Health/readiness + platform probes `[ ]`
**Size:** S · **Owner:** Opus
**Files:** `backend/server.js`, Flask `web_app.py`, bot `app.py`
**Spec:** `/api/health` = liveness (no deps, 200). New `/api/ready` = checks pg (`SELECT 1`) + returns `{db:true}` 200 / 503. Flask + bot keep `/api/health`. Document probe paths in compose + runbook.
**Verify (Fable):** stop postgres → `/api/ready` 503 while `/api/health` stays 200; restart → 200.

### Step 3.4 — CI: build + secret scan on push `[ ]`
**Size:** S · **Owner:** Opus
**Files:** new `.github/workflows/ci.yml`
**Spec:** On push/PR: frontend `npm ci && npm run build`; backend `npm ci` + `node --check server.js` (+ `npm run lint` if configured); python `py_compile` both apps; `gitleaks` action (or a grep-based fallback job) for secret patterns.
**Verify (Fable):** push a branch → workflow green; introduce a fake `ghp_xxxx` in a test commit on a throwaway branch → scan fails (then delete branch).

### Step 3.5 — Hosting decision (D3) + deploy runbook `[ ]` **USER-ACTION (decision)**
**Size:** M · **Owner:** USER decides; Opus writes `DEPLOYMENT.md`
**Spec:** Present the two packaged options (both already satisfied by 3.1):
- **(a) Managed PaaS:** frontend on Vercel/Netlify (SPA rewrites config included), backend+flask+bot on Railway/Render from Dockerfiles, managed Postgres (Neon/Railway) with `DATABASE_SSL=true`; set `CORS_ORIGINS`, `VITE_API_URL`, `VITE_SOCKET_URL`, Clerk **production** instance keys + allowed origins; custom domain + TLS automatic.
- **(b) Single VPS:** compose + nginx TLS (caddy/certbot), one origin (no CORS pain), you own updates/backups.
`DEPLOYMENT.md` runbook: env matrix per service (from Appendix A), migration step, Clerk prod checklist (prod instance, domains, keys), Slack app URL updates (events URL → prod), smoke checklist post-deploy.
**Verify (Fable):** runbook exists and every env var in Appendix A appears in it; user decision recorded in Execution Log.

### Step 3.6 — Deploy + production smoke `[ ]` **USER-ACTION (accounts/DNS) + Opus**
**Size:** M
**Spec:** Execute the runbook on the chosen host. Post-deploy smoke (scripted where possible): signup→org→wizard→save E2E on prod URL; 401 sweep from G1 re-run against prod; integration connect + Jira sync against a scratch Jira; socket connects over WSS; `/api/ready` 200; no mixed-content warnings; Lighthouse sanity on frontend.
**Verify (Fable):** run the smoke checklist against the live URL; record results + URL in Verification Log.

### Step 3.7 — Update CLAUDE.md to the new reality `[ ]`
**Size:** S · **Owner:** Opus
**Spec:** Rewrite stale sections: auth (Clerk, no admin/1234), persistence (Postgres, not localStorage), per-org integrations, env matrix, service run commands (waitress/gunicorn/docker), the standup-bot service, and remove the claim that data is localStorage-based. Keep conventions sections.
**Verify (Fable):** CLAUDE.md contains no references to `admin/1234`, localStorage-as-source-of-truth, or global `JIRA_API_TOKEN`.

### 🚧 GATE G3 — LAUNCH `[ ]`
1. All Phase-3 steps `[✓]`; production smoke green.
2. Secrets: only in host env config; master key backed up securely by user; Clerk prod instance live.
3. Backups: managed-PG automated backups verified ON (or documented pg_dump cron for VPS).
4. Uptime monitor pointed at `/api/ready` (user sets up; any free monitor).
5. This plan's Execution + Verification logs complete; tag `git tag v1.0-saas-launch`.

---

# PHASE 4 — Post-launch backlog (explicitly OUT of current scope)
| Item | Trigger |
|---|---|
| **Atlassian OAuth 3LO + GitHub App** (spike first: can 3LO scopes create projects? If not, keep token path for the create-project feature and OAuth for the rest) | First security-conscious customer / marketplace listing |
| Slack multi-workspace OAuth for standup bot (per-org Slack) | Second customer wants standups |
| Billing (Stripe) + per-org Gemini quotas/limits | Monetization |
| Master key → KMS (swap `wrapDek/unwrapDek` only) | Funding/compliance |
| Sentry (frontend+backend), E2E tests (Playwright), unit tests for scoring/sync | Post-launch stability |
| Per-page React error boundaries; self-host fonts; audit log; data export/GDPR delete | As needed |

---

# Appendix A — Environment variable matrix

### backend (`epic-dev-assignment/backend/.env`)
| Var | Phase | Notes |
|---|---|---|
| `PORT` | 0 | default 3003 |
| `DATABASE_URL` | 0 | **required** — no fallback (0.2) |
| `DATABASE_SSL` | 0 | `true` on managed PG |
| `FLASK_URL` | 0 | internal URL of epic-generator |
| `FOCUS_FLOW_URL` | 0 | internal URL of standup bot |
| `CORS_ORIGINS` | 0 | comma-separated frontend origins |
| `TRUST_PROXY` | 0 | `1` behind LB |
| `JSON_BODY_LIMIT` | 0 | default 2mb |
| `RATE_LIMIT_MAX` | 0 | default 300/15min |
| `INTERNAL_API_KEY` | 0 | shared with flask + bot |
| `DEV_REFRESH_CRON` | 0 | default `0 3 * * *` |
| `CLERK_SECRET_KEY` | 1 | |
| `CREDENTIALS_MASTER_KEY` | 2 | base64 32B; back it up — losing it = clients reconnect integrations |
| ~~`JIRA_DOMAIN/EMAIL/API_TOKEN/BOARD_ID`, `GITHUB_TOKEN`~~ | — | **removed in 2.8** (per-org now) |

### frontend (`.env` at build time — ALL PUBLIC)
| Var | Phase | Notes |
|---|---|---|
| `VITE_API_URL` | 0 | empty = same-origin |
| `VITE_SOCKET_URL` | 0 | defaults to API URL / origin |
| `VITE_CLERK_PUBLISHABLE_KEY` | 1 | publishable = safe to expose |

### epic-generator (`.env`)
| Var | Phase | Notes |
|---|---|---|
| `GEMINI_API_KEY` | 0 | platform-owned (D5) |
| `FLASK_DEBUG` / `HOST` / `PORT` | 0 | default false / 127.0.0.1 / 5000 |
| `CORS_ORIGINS` | 0 | |
| `INTERNAL_API_KEY` | 0 | must match backend |

### standup-bot (`.env`)
| Var | Phase | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | 0 | rotated in 0.1 |
| `SLACK_SIGNING_SECRET` | 0 | **new** — required non-debug |
| `GEMINI_API_KEY` | 0 | |
| `JIRA_URL/EMAIL/API_TOKEN/PROJECT_KEY` | 0 | bot stays single-workspace (D6) |
| `EXPRESS_DB_URL` | 0 | backend standups endpoint |
| `INTERNAL_API_KEY` | 0 | must match backend |
| `ADMIN_API_KEY` | 0 | gates `/test/*`; unset = routes 404 |
| `REMINDER_HOUR` / `REMINDER_MINUTE` | 0 | default 9 / 30 |
| `STANDUP_ORG_ID` | 1 | Clerk org id this bot posts into |
| `HOST` / `PORT` | 0 | default 127.0.0.1 / 3000 |

---

# Execution Log (Opus appends; newest last)
| Date | Step | Commit | Notes |
|---|---|---|---|
| 2026-07-14 | 0.0 | `p0.0: description validation across all 3 layers + standup ticket extraction safety net` | Executed by Fable while establishing the regression baseline (build + py_compile green first) |
| 2026-07-14 | harness | `test: regression baseline — 74 unit tests + smoke harness across all 4 services` | Also fixed missing `python-dotenv` in epic-generator/requirements.txt; created standup-bot/.venv |
| 2026-07-14 | 0.2 | `p0.2: remove hardcoded DB password from db.js; fail-fast + DATABASE_SSL` | Both scripts already load dotenv; db.js intentionally does NOT self-load it (keeps fail-fast verifiable). Note: old password remains in git history (commit cdd635f) — Step 0.1 rotation still required. |
| 2026-07-14 | 0.1 | (user action — .env only, no commit) | User rotated all 5. Each verified live: Postgres (backend connects), GitHub PAT (200, `repo` scope, user moizkhan38), Jira token (200 /myself, both backend + bot .env), Gemini key (200 models list, both epic-generator + bot .env), Slack bot token (auth.test ok, team "Focus Flow") + signing secret (32-char). **FOLLOW-UP:** the GitHub token was briefly pasted in chat during setup — regenerate it once and update backend/.env so it has never left the machine. |
| 2026-07-14 | 0.3 | `p0.3: harden Flask — debug off, CORS lock, internal-key gate, waitress` | app.run env-driven (FLASK_DEBUG/HOST/PORT, defaults false/127.0.0.1/5000); dropped API-key debug print; CORS→CORS_ORIGINS; before_request X-Internal-Key gate (health exempt); 500s return generic msg + log; waitress in requirements; flaskProxy.js sends X-Internal-Key. jira.js:42 unchanged (hits exempt /api/health). |
| 2026-07-14 | 0.4 | `p0.4: harden standup bot — Slack sig verify, daily reminder, gate /test + /api/standup` | before_request gates: /slack/* Slack signature (refuse-to-start w/o secret unless FLASK_DEBUG), /api/standup* X-Internal-Key (dev no-op), /test/* X-Admin-Key→404 unless set; reminder 2min→daily CronTrigger(REMINDER_HOUR/MINUTE); /slack/events payload parse guarded; app.run env HOST/PORT + waitress; standup_data.json path via __file__. Express routes/standup.js sends X-Internal-Key. Test sets dummy SLACK_SIGNING_SECRET. |
| 2026-07-14 | 0.5 | `p0.5: harden Express — trust proxy, rate limit, error handler, guards, cron lock` | trust proxy (TRUST_PROXY); body limit 50mb→JSON_BODY_LIMIT(2mb); global /api rate limit (RATE_LIMIT_MAX 300/15m, health registered before it); CORS disallowed→cb(null,false); global error middleware (expose-gated); unhandledRejection/uncaughtException guards; SIGTERM/SIGINT graceful shutdown (io.close+pool.end, 10s force); dev-refresh cron wrapped in pg_try_advisory_lock(823471). .env.example +TRUST_PROXY/JSON_BODY_LIMIT/RATE_LIMIT_MAX. |
| 2026-07-14 | 0.6 | `p0.6: stop leaking internal errors — sendServerError/sendUpstreamError sweep` | New utils/httpError.js: sendServerError (internal → generic + log) and sendUpstreamError (Jira parseJiraError output → safe passthrough, still logged). Swept 34 sites across db/jira/sync/assignment/epics/developers/standup. Kept: Jira warnings[]/health feedback + server logs + developers.js filtered per-user error (never sent). |
| 2026-07-15 | 0.7 | `p0.7: frontend env-driven API base + socket URL (VITE_API_URL)` | New src/lib/api.js (API_BASE, SOCKET_URL, apiUrl, apiFetch). Swept 16 direct fetch('/api') sites across 11 files + safeFetchJson wrapper (WorkflowContext ×4) + SWR fetcher (useSprintData) to apiFetch; useRealtime io()→SOCKET_URL. New frontend/.env.example (VITE_API_URL / VITE_SOCKET_URL, public-only note). Dev unchanged (empty API_BASE → Vite proxy). |

# Verification Log (Fable appends; newest last)
| Date | Step | Result | Evidence |
|---|---|---|---|
| 2026-07-14 | 0.0 | ✓ | Verified via full harness: 74/74 unit tests green; smoke `--ai` 25 PASS / 0 FAIL (3 epics, 6 stories generated end-to-end); `npm run build` clean; WIP validation behavior pinned by backend/frontend/flask suites |
| 2026-07-14 | 0.2 | ✓ | Fail-fast exits 1 without DATABASE_URL (clear msg); connects with env (ping ok); `git grep moizdanishmand25` clean in tracked source; backend units 26/26; smoke 22 PASS / 0 FAIL |
| 2026-07-14 | 0.1 | ✓ | All 5 credentials authenticated against their live APIs (Postgres/GitHub/Jira/Gemini/Slack); `git log --all -- **/.env` empty; `git grep` of secret patterns in tracked files clean |
| 2026-07-14 | 0.3 | ✓ | Flask boots debug=False on 127.0.0.1; gate with INTERNAL_API_KEY=testkey123 → POST /api/generate no key=401, GET /api/health no key=200, POST with key=400(validation); no `debug=True`/key-logging in source; waitress 3.0.2 importable; Flask units 21/21 |
| 2026-07-14 | 0.4 | ✓ | Bot boots on 127.0.0.1:3000; forged POST /slack/events=401, GET /test/reminder (no admin key)=404, /api/health=200, /api/standup/history=200; grep: no minutes=2, SignatureVerifier + CronTrigger present; bot units 9/9; waitress installed |
| 2026-07-14 | 0.5 | ✓ | node --check OK; all 9 hardening elements present; GET /api/health=200; hostile Origin → no ACAO header, status 200 (not 500); rate limit exact: 305 reqs → 300×404 + 5×429; backend units 26/26. (SIGTERM handler present + valid; runtime signal behavior deferred to Linux containers in Phase 3.) |
| 2026-07-14 | 0.6 | ✓ | All 7 routes + helper node --check OK; grep confirms zero err.message on any status(500) line; good-DB smoke green (db CRUD + validation, 19 PASS); forced 500 (bad DB pw) → client gets `{"error":"Internal server error"}`, server log holds real `password authentication failed`. |
| 2026-07-15 | 0.7 | ✓ | `npm run build` OK (9.9s); grep: no direct fetch('/api') outside lib/api.js; **zero `localhost:3003` in dist/assets/*.js** (DEV fallback tree-shaken); no localhost refs anywhere in bundle. Full wizard-through-apiFetch dev smoke deferred to G0. |
