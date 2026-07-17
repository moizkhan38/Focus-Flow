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
| Backend unit | `cd epic-dev-assignment/backend && npm test` | 32/32 (26 + 6 crypto, added at G2) |
| Frontend unit | `cd epic-dev-assignment/frontend && npm test` | 18/18 |
| Flask unit | `cd epic-generator && venv/Scripts/python.exe -m unittest discover -s tests` | 22/22 (was 21; +1 gate test at G2) |
| Bot unit | `cd standup-bot && .venv/Scripts/python.exe -m unittest discover -s tests` | 10/10 (was 9; +1 gate test at G2) |
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
| **D7** | **When Slack goes multi-workspace: one Slack workspace ↔ exactly ONE organization (strict 1:1).** `slack_workspaces(team_id PK, org_id NOT NULL UNIQUE, ciphertext, key_version, installed_by, …)` — both constraints required. Install is a plain **INSERT that is allowed to fail**, never an upsert: conflict on `team_id` → 409 "already connected to another organization" (**never name the other org** — leaks tenant existence); conflict on `org_id` → 409 "disconnect your current workspace first". Re-binding requires an admin of the *owning* org to disconnect first. | **User's decision (2026-07-16).** The PK is a tenant boundary, not bookkeeping: an upsert would let org B's install silently re-bind org A's workspace, redirecting A's standups + reminders into B — same class as the cross-org project-id theft blocked in 1.6, same 409 answer. `org_id UNIQUE` keeps the reminder scheduler unambiguous. **Revisit when:** an agency needs one workspace across several orgs (→ per-channel binding), or a customer is on Slack Enterprise Grid (`enterprise_id` + many `team_id`s). Neither is a v1 problem; 1:1 is the default that cannot leak. |

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

### Step 0.8 — Migration runner: tracking table + transactions `[x]`
**Size:** S · **Owner:** Opus
**Why:** A10. Runner re-applies all files every run, no transaction — a future non-idempotent migration double-applies or half-applies.
**Files:** `backend/scripts/migrate.js`, `backend/package.json`
**Spec:**
- Create `schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())` if missing.
- For each `migrations/*.sql` sorted: skip if recorded; else `BEGIN` → run file → `INSERT INTO schema_migrations` → `COMMIT` (rollback + abort on error, log which file failed).
- `package.json`: add `"migrate": "node scripts/migrate.js"`.
**Accept:** running `npm run migrate` twice in a row: first run applies pending, second prints "0 pending".
**Verify (Fable):** run twice, observe idempotency; `SELECT * FROM schema_migrations` lists `001_init.sql`.

### Step 0.9 — Portability + env-example sweep `[x]`
**Size:** S · **Owner:** Opus
**Why:** Machine-specific path in `scripts/import-standups.js:6`; `.env.example` files must document every env var Phase 0 introduced.
**Files:** `backend/scripts/import-standups.js`, all four `.env.example` files, `README.md`
**Spec:**
- `import-standups.js`: take the JSON path as `process.argv[2]`, default `../../standup-bot/standup_data.json` resolved from the script dir; remove the `c:/Users/user/...` literal.
- Reconcile all `.env.example`s against the **Appendix A env matrix** (Phase-0 rows).
- README: add a short "Production notes" section pointing at this plan.
**Accept:** `git grep -n "c:/Users\|C:\\\\Users" -- ':!*.md'` → nothing tracked.
**Verify (Fable):** grep passes; each `.env.example` contains every Phase-0 var from Appendix A.

### 🚧 GATE G0 — Phase 0 complete `[x]` ✅ fully green (Gemini caveat RESOLVED via lite model)
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

### Step 1.1 — Clerk application setup `[x]` **USER-ACTION**
**Size:** S · **Owner:** USER (Opus guides)
**Spec (user):** Create app at dashboard.clerk.com → enable **Organizations** (Settings → Organizations) → copy `CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (dev instance) → give to Opus for `.env` placement (`frontend/.env.local`: `VITE_CLERK_PUBLISHABLE_KEY`; `backend/.env`: `CLERK_SECRET_KEY`).
**Accept:** Keys present locally (never committed); Clerk dashboard shows Organizations enabled.
**Verify (Fable):** `.env.example`s updated with empty placeholders; `git grep "pk_live\|pk_test\|sk_live\|sk_test"` → nothing tracked.

### Step 1.2 — Frontend: ClerkProvider, sign-in, org gating `[x]`
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

### Step 1.3 — Frontend: authenticated API layer + socket auth `[x]`
**Size:** M · **Owner:** Opus
**Files:** `frontend/src/lib/api.js`, new `src/lib/AuthBridge.jsx`, `src/hooks/useRealtime.js`, SWR fetchers
**Spec:**
1. In `lib/api.js` add a module-level token getter: `let tokenGetter = null; export function setTokenGetter(fn){tokenGetter = fn}`. `apiFetch` becomes: get token (`await tokenGetter?.()`), attach `Authorization: Bearer <token>` when present, then fetch. On 401 response → `window.dispatchEvent(new Event('auth:expired'))`.
2. `AuthBridge.jsx` (rendered once inside ClerkProvider): `const { getToken } = useAuth(); useEffect(() => setTokenGetter(() => getToken()), [getToken])`.
3. All SWR fetchers already flow through `apiFetch` (0.7) — confirm none bypass it.
4. Socket: connect with `auth: { token: await tokenGetter() }`; reconnect logic refreshes the token (`socket.auth.token = ...` before reconnect attempts).
**Accept:** Network tab shows `Authorization: Bearer` on every `/api/*` request when signed in.
**Verify (Fable):** devtools check; sign out → API calls stop (guard redirects); no fetch site imports raw `fetch` for `/api` paths (`grep`).

### Step 1.4 — Backend: Clerk middleware, org enforcement, socket auth, internal-auth path `[x]`
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

### Step 1.5 — DB migration 002: org_id columns (+ backfill script) `[x]`
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

### Step 1.6 — Backend: org-scope every DB query; migration 003 enforces NOT NULL `[x]`
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

### Step 1.7 — Frontend: swap localStorage hooks to Postgres-backed SWR `[x]`
> **Review finding (2026-07-15, confirmed):** unscoped localStorage keys (`focus-flow-projects` etc.) leak tenant data across accounts/orgs on a shared browser — nothing purges them on sign-out. **Resolved BY this step** (server becomes source of truth; local copies removed). Deliberately NOT purge-on-signout before 1.7: localStorage is the ONLY store until then, purging = user data loss. Risk window acceptable (localhost dev, single user, G1 blocks multi-user use until 1.7 done).
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

### Step 1.8 — Remove legacy auth artifacts `[x]`
**Size:** S · **Owner:** Opus
**Files:** delete `src/context/AuthContext.jsx`; purge remnants in `Login.jsx` (if replaced wholesale, delete), Header, App.jsx imports
**Spec:** Remove AuthContext + hardcoded credentials + "Default credentials: admin / 1234" copy + `focus-flow-auth` sessionStorage usage. Fix all imports; build must pass.
**Accept:** `git grep -n "focus-flow-auth\|admin.*1234"` → nothing; build passes.
**Verify (Fable):** greps + `npm run build`; signed-out user cannot render any app route (manual).

### 🚧 GATE G1 — Phase 1 complete `[✓]`
1. All Phase-1 steps `[✓]`.
2. **End-to-end:** fresh incognito → sign up → create org → wizard: generate epics → approve → analyze devs → assign → Save (without Jira) → project visible in DB and after refresh → second member invited via Clerk sees the same project; a **different** org sees nothing (full isolation matrix from 1.6 re-run).
3. Every `/api/*` (minus health + internal paths) returns 401 unauthenticated — scripted curl sweep over: generate, regenerate, classify-epics, analyze-developers, auto-assign, reassign, all `/api/db/*`, all `/api/jira/*`, sync-jira.
4. Socket connects only with a valid token; cross-org room join rejected.
5. `npm run build` clean.
6. Regression harness green with Phase-1 expectations (smoke's open-access checks become 401 assertions; authed-request variants added with a test token).

---

# PHASE 2 — Per-tenant Jira & GitHub (the SaaS core)
*Kill global `JIRA_*`/`GITHUB_TOKEN`; each org connects its own credentials, envelope-encrypted; services take credentials per request via `credentialProvider`.*

### Step 2.1 — Migration 005: `org_integrations` `[x]`
**Size:** S · **Owner:** Opus
**Files:** new `backend/migrations/005_org_integrations.sql` (plan said 004; 004 was taken by developers_email in 1.7)
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

### Step 2.2 — Envelope encryption service `[x]`
**Size:** M · **Owner:** Opus
**Files:** new `backend/services/cryptoService.js`, `backend/.env.example`
**Spec:**
1. AES-256-GCM envelope: per-secret random 32-byte DEK encrypts the JSON payload; DEK is wrapped by the **master key** (`CREDENTIALS_MASTER_KEY`, base64 32 bytes, from env for v1). Stored blob: `{v:1, kv:<key_version>, dekIv, dekTag, dekCt, iv, tag, ct}` (all base64).
2. API: `encryptJson(obj) → string`, `decryptJson(string) → obj`. Master-key access isolated in two internal fns `wrapDek/unwrapDek` — the future KMS swap touches only those (leave a comment saying exactly that).
3. Fail fast at boot if `CREDENTIALS_MASTER_KEY` missing/malformed **when any integration route is mounted** (i.e., always in Phase 2+): clear error + exit.
4. Generation helper for the user: document `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` in `.env.example`.
5. Unit sanity script `scripts/crypto-selftest.js`: encrypt→decrypt round-trip + tamper detection (flip a byte → must throw).
**Verify (Fable):** `node scripts/crypto-selftest.js` passes; boot without master key → exit 1 clear message; DB rows (after 2.4) contain no plaintext (`SELECT ciphertext FROM org_integrations` — no `atlassian.net`, no `ghp_`).

### Step 2.3 — credentialProvider `[x]`
**Size:** M · **Owner:** Opus
**Files:** new `backend/services/credentialProvider.js`
**Spec:**
- `getJiraCredentials(orgId) → {domain, email, apiToken} | null`; `getGithubToken(orgId) → string | null`; `setIntegration(orgId, provider, payloadObj)` (encrypt + upsert + cache-bust); `deleteIntegration(orgId, provider)`; `getStatus(orgId) → {jira:{connected, domain, email}, github:{connected, tokenSuffix}}` (**never** returns secrets — domain/email ok, token only last-4).
- In-memory TTL cache (5 min) keyed `orgId:provider`; invalidated on set/delete.
- Typed error: `IntegrationNotConnectedError(provider)` for downstream 412 mapping.
**Verify (Fable):** code review — no code path returns the decrypted token except `getJiraCredentials/getGithubToken` consumed by services; cache invalidation on set (write a 20-line script: set → get → set new → get returns new).

### Step 2.4 — Integrations API + admin gating `[x]`
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

### Step 2.5 — jiraService → per-org client factory `[x]`
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

### Step 2.6 — githubService → per-org token; refresher per-org `[x]`
**Size:** M · **Owner:** Opus
**Files:** `backend/services/githubService.js`, `backend/routes/developers.js`, `backend/services/developerRefresher.js`
**Spec:**
1. `githubService` functions take a `token` (or a `createGithubClient(token)` factory mirroring 2.5); remove `process.env.GITHUB_TOKEN` reads.
2. `routes/developers.js` (`/api/analyze-developers`): resolve token via provider; if not connected → **412** `{error:'GITHUB_NOT_CONNECTED'}` (unauthenticated GitHub = 60 req/hr — not viable; require connection).
3. `developerRefresher.js`: outer loop over orgs that have a github integration (`SELECT DISTINCT org_id …` join `org_integrations`); refresh that org's developers with that org's token; skip orgs without one (log once).
**Verify (Fable):** grep for `GITHUB_TOKEN` in backend src → gone; analyze-developers without connection → 412; with → works (manual, one username).

### Step 2.7 — Settings UI: Connect Jira / Connect GitHub `[x]`
**Size:** L · **Owner:** Opus
**Files:** `frontend/src/pages/jira/Settings.jsx` (read first — repurpose), `src/lib/api.js` (412 handling), touch-points: `SyncButton.jsx`, `useSprintData.js`/`useKanbanSync.js` empty states, `AssignPage`/`Step3` (GitHub), `Dashboard.jsx`
**Spec:**
1. Settings page becomes **Integrations**: two cards (Jira, GitHub) — status badge (Connected as `you@x` on `acme.atlassian.net` / Not connected), inputs (Jira: domain, email, API token w/ link to id.atlassian.com token page; GitHub: PAT w/ scopes note `repo` read), buttons: Connect (PUT), Test, Disconnect (confirm dialog). Admin-only editing: non-admins see status + "Ask an org admin". Tokens are write-only (never displayed; placeholder `••••` when connected).
2. `apiFetch`: expose response handling so callers can detect 412 codes `JIRA_NOT_CONNECTED`/`GITHUB_NOT_CONNECTED` (e.g. throw typed error `{code}`).
3. Graceful not-connected UX: Dashboard/Kanban/Reports → centered empty state "Connect Jira to see sprint data" + button → `/settings`; SyncButton disabled with tooltip when Jira not connected (fetch status once via SWR `GET /api/integrations`); Step3/AssignPage analyze → inline notice when GitHub not connected.
4. Follow theme conventions (semantic utilities, light default).
**Accept:** New org: everything AI-side works; Jira/GitHub surfaces show connect CTAs, no red error spam. Connect Jira → dashboards light up.
**Verify (Fable):** manual walk of the matrix (no integrations / jira only / both); non-admin cannot save (403 surfaced politely); token never appears in any GET response or the DOM after save.

### Step 2.8 — Kill global integration env vars + docs `[x]`
**Size:** S · **Owner:** Opus
**Files:** `backend/.env.example`, `backend/.env` (user's local), `README.md`, `.claude/CLAUDE.md`
**Spec:** Remove `JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_BOARD_ID/GITHUB_TOKEN` from backend `.env.example` (bot keeps its own per D6). Tell the user to delete them from local `.env` and instead connect via Settings UI. Update README + CLAUDE.md "Environment Variables" + add the per-org integrations model to CLAUDE.md architecture notes.
**Verify (Fable):** backend boots with those vars absent; grep `.env.example` — gone; CLAUDE.md updated.

### 🚧 GATE G2 — Phase 2 complete `[✓]`
1. All Phase-2 steps `[✓]`.
2. **Two-org integration isolation:** org A connects Jira-A, org B has none → A syncs a project into Jira-A successfully; B's Jira endpoints → 412; B cannot see A's integration status; DB `org_integrations` ciphertext opaque.
3. Full E2E on org A: wizard → assign → **Sync to Jira** → verify in Jira Cloud: project, board, sprints, stories w/ points + assignees, invited developer email (per CLAUDE.md sync flow).
4. Secret hygiene: server logs from the E2E contain no token material; `GET /api/integrations` responses contain no token.
5. Backend has zero reads of `JIRA_*`/`GITHUB_TOKEN` env.
6. Regression harness green with Phase-2 expectations (412 not-connected checks added for Jira/GitHub endpoints; crypto self-test in the unit run).

---

# PHASE 3 — Production infrastructure & launch
*Host-agnostic packaging, observability, runbook; hosting decision (D3) gets made here.*

### Step 3.1 — Dockerfiles + compose (prod parity) `[x]`
**Size:** M · **Owner:** Opus
**Files:** new `epic-dev-assignment/backend/Dockerfile`, `epic-generator/Dockerfile`, `standup-bot/Dockerfile`, `epic-dev-assignment/frontend/Dockerfile` (build → nginx serve w/ SPA fallback + `/api` proxy example), root `docker-compose.prod.yml`, `.dockerignore`s
**Spec:** Node 22-alpine multi-stage for backend (npm ci --omit=dev, non-root user, `CMD node server.js`); python:3.12-slim + gunicorn for both Flask apps (non-root); frontend: build stage (accepts `VITE_*` build args) → nginx:alpine with `try_files $uri /index.html` + example `location /api` proxy. Compose wires: postgres:16 (volume), backend (depends_on pg, runs `npm run migrate` before start via entrypoint), flask, bot, frontend; all env via `env_file`; only frontend + backend ports exposed; flask/bot internal-only.
**Verify (Fable):** `docker compose -f docker-compose.prod.yml up --build` → full stack healthy; wizard E2E through `http://localhost:<frontend-port>`; flask/bot unreachable from host except via backend.

### Step 3.2 — Structured logging + request IDs `[x]`
**Size:** M · **Owner:** Opus
**Files:** `backend/` (pino + pino-http), light-touch on Flask/bot (Python `logging` with level env)
**Spec:** `pino` logger module; `pino-http` with request-id generation (respect inbound `X-Request-Id`); replace `console.*` in server.js, db.js, middleware, and the hottest routes (sync.js, jira.js) with the logger (leave deep service `console.log`s as debug-level follow-up); redaction config for `authorization`, `apiToken`, `token` fields. Flask/bot: `LOG_LEVEL` env, timestamps, replace bare prints in request paths (keep it pragmatic).
**Verify (Fable):** logs are JSON lines with req ids; trigger a sync → one correlated id across its log lines; grep logs for token patterns during an integration save → nothing.

### Step 3.3 — Health/readiness + platform probes `[x]`
**Size:** S · **Owner:** Opus
**Files:** `backend/server.js`, Flask `web_app.py`, bot `app.py`
**Spec:** `/api/health` = liveness (no deps, 200). New `/api/ready` = checks pg (`SELECT 1`) + returns `{db:true}` 200 / 503. Flask + bot keep `/api/health`. Document probe paths in compose + runbook.
**Verify (Fable):** stop postgres → `/api/ready` 503 while `/api/health` stays 200; restart → 200.

### Step 3.4 — CI: build + secret scan on push `[x]`
**Size:** S · **Owner:** Opus
**Files:** new `.github/workflows/ci.yml`
**Spec:** On push/PR: frontend `npm ci && npm run build`; backend `npm ci` + `node --check server.js` (+ `npm run lint` if configured); python `py_compile` both apps; `gitleaks` action (or a grep-based fallback job) for secret patterns.
**Verify (Fable):** push a branch → workflow green; introduce a fake `ghp_xxxx` in a test commit on a throwaway branch → scan fails (then delete branch).

### Step 3.5 — Hosting decision (D3) + deploy runbook `[x]` **USER-ACTION (decision)**
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

### Step 3.7 — Update CLAUDE.md to the new reality `[x]`
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
| **Slack multi-workspace OAuth for standup bot (per-org Slack)** — design settled, see D7. See "Phase 4 detail: Slack multi-workspace" below. | Second customer wants standups |
| Billing (Stripe) + per-org Gemini quotas/limits | Monetization |
| Master key → KMS (swap `wrapDek/unwrapDek` only) | Funding/compliance |
| Sentry (frontend+backend), E2E tests (Playwright), unit tests for scoring/sync | Post-launch stability |
| Per-page React error boundaries; self-host fonts; audit log; data export/GDPR delete | As needed |

## Phase 4 detail: Slack multi-workspace (design settled 2026-07-16 — build only when D6's trigger fires)

**Why it can't wait for "just add a token field":** unlike Jira/GitHub, a client cannot paste a Slack
bot token — their workspace must *install* the app via OAuth, and the install must prove which org it
belongs to. Audited state of `standup-bot/app.py` (2026-07-16): **`team_id` appears nowhere**, there is
ONE module-level `slack_client = WebClient(token=os.environ["SLACK_BOT_TOKEN"])` (app.py:66), and 3
scheduler jobs assume "the" workspace. It doesn't degrade with a 2nd workspace — it structurally
cannot serve one.

**Install flow** (the whole feature):
1. Org admin clicks Connect Slack in Integrations → `/slack/install`.
2. Redirect to Slack OAuth with a **signed, nonce'd, short-TTL `state` carrying the orgId**.
3. Callback `/slack/oauth/callback?code&state` → verify the state signature → trust orgId; exchange
   `code` → `team_id` + workspace bot token.
4. `INSERT INTO slack_workspaces …` per **D7** (fail-on-conflict, never upsert).
   ⚠️ **The `state` signature is the security-critical piece** — unsigned state lets an attacker bind
   THEIR workspace to YOUR org, flowing their standups into your data. Highest-review-effort item.

**Bot refactor** — the same per-tenant client-factory pattern as 2.5/2.6, applied a third time:
- Read `team_id` off every inbound payload → resolve org + token → **per-request `WebClient`**
  (kills the module-level global). Cache the lookup: slash commands have a **3-second deadline**.
- Standups already write with `X-Org-Id` (1.4) — that part is done.
- Jira transitions resolve **that org's** stored creds → **this is what finally removes the bot's
  plaintext `JIRA_URL/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_PROJECT_KEY`** (post-Phase-2, the bot is the last
  holder of global Jira credentials on disk — D6's intentional exception).
- The 3 scheduler jobs loop workspaces instead of assuming one.

**Storage is already built:** Slack tokens reuse `cryptoService`'s envelope + the `credentialProvider`
shape unchanged — the D1 abstraction paying off. No new crypto.

**Slack-specific gotchas:**
- **Slack app review is NOT required.** Review gates App Directory *listing* only; **unlisted
  distribution** (send customers an install link) is enough for B2B and skips it entirely. Do not
  budget weeks for review.
- Signing secret is **per-app, not per-workspace** → stays a single env var.
- Handle `app_uninstalled` → delete the row, else you retain a dead token and keep hammering it.
- Slack now supports token rotation/refresh tokens — optional, better.

**Prerequisite worth doing early (independently useful):** point the bot at the org's stored Jira
credentials instead of its own env. Removes the last plaintext token from disk AND is required by the
refactor above — the one piece that isn't wasted if a 2nd customer never appears. Open question to
settle first: the bot is Python and `credentialProvider` is Node, so Express would need an
internal-key-gated endpoint handing decrypted creds over localhost — trading credential-at-rest for
credential-over-the-wire. Decide deliberately; don't bolt it on.

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
| `CLERK_PUBLISHABLE_KEY` | 1 | backend also needs it (clerkMiddleware) |
| `CREDENTIALS_MASTER_KEY` | 2 | base64 32B; back it up — losing it = clients reconnect integrations |
| `LOG_LEVEL` | 3 | pino level, default `info` |
| ~~`JIRA_DOMAIN/EMAIL/API_TOKEN/BOARD_ID`, `GITHUB_TOKEN`~~ | — | **removed in 2.8** (per-org now) |

### root compose (`.env` at repo root — used by `docker-compose.prod.yml`)
| Var | Phase | Notes |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 3 | compose postgres + backend DATABASE_URL (VPS/compose path only) |
| `FRONTEND_PORT` / `BACKEND_PORT` | 3 | published host ports (default 8080 / 3003) |
| `VITE_API_URL` / `VITE_SOCKET_URL` / `VITE_CLERK_PUBLISHABLE_KEY` | 3 | frontend build args (public) |

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
| `GEMINI_MODEL` | model-fix | default `gemini-flash-lite-latest` |
| `FLASK_DEBUG` / `HOST` / `PORT` | 0 | default false / 127.0.0.1 / 5000 |
| `CORS_ORIGINS` | 0 | |
| `INTERNAL_API_KEY` | 0 | must match backend |
| `LOG_LEVEL` | 3 | Python logging level, default `INFO` |

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
| `GEMINI_MODEL` | model-fix | default `gemini-flash-lite-latest` |
| `STANDUP_DATA_FILE` | 3 | override local JSON path (compose volume) |
| `LOG_LEVEL` | 3 | Python logging level, default `INFO` |
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
| 2026-07-15 | 0.8 | `p0.8: migration runner — schema_migrations tracking + per-file transactions` | migrate.js: creates schema_migrations(filename PK, applied_at); skips applied files; each pending file runs in BEGIN/COMMIT with ROLLBACK on error. package.json +migrate script. |
| 2026-07-15 | 0.9 | `p0.9: portability — kill machine path, reconcile env-examples, README prod notes` | import-standups.js: c:/Users/... literal → path.resolve(__dirname,'..','..','..','standup-bot','standup_data.json') + argv[2] override. backend/.env.example +FOCUS_FLOW_URL +DEV_REFRESH_CRON. README: migrate cmd → npm run migrate + new Production notes section pointing at this plan. |
| 2026-07-15 | 1.1 | (user action — .env only) | Clerk app "Focus Flow" created (instance handy-gannet-17). Keys verified live: pk in frontend/.env.local (decodes to instance domain), sk in backend/.env (200 on /v1/users). Organizations enabled, **membership required** mode (200 on /v1/organizations). Packages installed: @clerk/clerk-react 5.61.9, @clerk/express, @clerk/backend. |
| 2026-07-15 | 1.2 | `p1.2: Clerk frontend — provider, SignIn/SignUp, org-gated AuthGuard, org switcher` | main.jsx ClerkProvider (fail-fast ConfigError w/o key); routes /login/* + /signup/* (path routing); AuthGuard → SignedIn/SignedOut + OrgGate (OrganizationList hidePersonal); Login/Signup pages w/ branding; Header + Sidebar get OrganizationSwitcher/UserButton; Sidebar logout → useClerk().signOut() (user caught the dead old logout during interactive test). AuthContext mounted but consumer-free (1.8 removes). |
| 2026-07-15 | 1.3 | `p1.3: authed API layer — token getter bridge + Bearer on every call + socket auth` | lib/api.js: setTokenGetter/getAuthToken; apiFetch attaches Authorization: Bearer (fresh JWT per request), dispatches auth:expired on 401. AuthBridge.jsx (inside ClerkProvider) registers Clerk getToken. useRealtime: socket auth as function → fresh token on every (re)connect. All call sites already routed via apiFetch (0.7). Interactive proof lands with 1.4 enforcement. |
| 2026-07-15 | 1.5 | `p1.5: migration 002 — org_id tenancy columns + legacy backfill script` (plan rows logged with p1.6) | 002 applied; backfill claimed 3 developers + 37 standups for the user's org (org_3GXt…kPn, "Moiz's Organization"); STANDUP_ORG_ID bound in bot .env. |
| 2026-07-15 | 1.6 | `p1.6: org-scope every DB query; migration 003 NOT NULL + composite PK; socket room org check` | All db.js queries org-scoped (lists WHERE org_id; by-id AND org_id + 404; inserts set org_id; projects upsert blocks cross-org id theft → 409; assignments bulk verifies project ownership → 403). 003: NOT NULL ×5, developers PK → (org_id, username). developers.js upsert + developerRefresher per-(org,username). Socket join now validates project ∈ socket.orgId. Internal standup writes REQUIRE X-Org-Id (400 otherwise). |
| 2026-07-15 | 1.7 | `p1.7: server-backed data — useProjects/useDevelopers/useRetro off localStorage` | All three hooks keep IDENTICAL interfaces (zero consumer edits): useProjects = context + optimistic state + per-project debounced saves (raw JSONB holds full client object; flat cols for server queries), refetch on org switch, state cleared on sign-out — **closes the cross-account leak finding**; useDevelopers/useRetro = SWR shared-cache + optimistic mutate. Migration 004 adds developers.email (was localStorage-only, needed for Jira invites). ProjectsPage one-time import banner for pre-1.7 local projects (parks old data under .migrated key). localStorage keeps only: theme, wizard drafts, templates (D4). |
| 2026-07-16 | 2.4 | `p2.4: integrations API — admin-gated connect/test, mount + boot fail-fast` | New routes/integrations.js mounted on /api (inherits the default-closed requireOrg gate): GET /integrations (status, any member), PUT /integrations/jira|github (requireOrgAdmin — validates domain `^[a-z0-9-]+\.atlassian\.net$`/email/token, **tests live creds before save** via Jira /rest/api/3/myself + GitHub /user, stores github login), DELETE /integrations/:provider, POST /integrations/:provider/test (stored creds). Tokens write-only (never returned/logged). New middleware requireOrgAdmin (403 ORG_ADMIN_REQUIRED; runs after the gate's requireOrg). server.js: assertMasterKey() boot fail-fast + router mount. Verified on running stack: all 5 integrations endpoints 401 unauthed; boot without master key → exit 1 (clear msg, before port bind); node --check clean. smoke-test.mjs: +5 integrations 401 checks; Flask validation checks now internal-key-aware (send X-Internal-Key when SMOKE_INTERNAL_KEY set → 400; SKIP w/ guidance when gate active + no key — fixes pre-existing env-drift red). Smoke bare 26 PASS/0 FAIL; +key 29 PASS/0 FAIL. Backend units 26/26. Authed admin/non-admin path (403/400/200) = G2 browser. |
| 2026-07-16 | 2.3 | `p2.3: credentialProvider — per-org integration creds over cryptoService` | New services/credentialProvider.js: getJiraCredentials/getGithubToken (decrypt via cryptoService), setIntegration (encrypt+upsert, key_version=1), deleteIntegration, getStatus (safe — jira: domain/email; github: login + token last-4; NO secrets). 5-min in-memory TTL cache keyed orgId:provider (caches misses too), busted on set/delete. IntegrationNotConnectedError(provider) with .code `<PROVIDER>_NOT_CONNECTED` for downstream 412. Live-DB verification (throwaway org, rows cleaned): 13/13 — round-trip, **set busts cache (new token returned)**, status redaction, ciphertext opaque (no atlassian.net/ATATT/ghp_/login leak), delete semantics. Not wired to any route yet (2.4) → no runtime path change; units 26/26. |
| 2026-07-16 | 2.2 | `p2.2: envelope encryption service (AES-256-GCM) + crypto self-test` | New services/cryptoService.js: per-secret 32B DEK (AES-256-GCM) encrypts the JSON payload; DEK wrapped by CREDENTIALS_MASTER_KEY (base64 32B). Blob `{v,kv,dekIv,dekTag,dekCt,iv,tag,ct}` all base64. API encryptJson/decryptJson; wrapDek/unwrapDek isolated as the sole KMS-swap seam (commented). assertMasterKey() = boot fail-fast (missing/malformed → exit 1, clear msg), wired by 2.4's route. scripts/crypto-selftest.js: 6/6 PASS (round-trip, opacity, shape, payload-tamper reject, DEK-tamper reject, wrong-key reject) + `npm run crypto-selftest`. .env.example documents CREDENTIALS_MASTER_KEY + randomBytes gen helper; real key generated into local gitignored .env (value never printed/committed; configured-key round-trip verified via dotenv). Nothing imports it at boot yet (route mounts in 2.4) → zero regression; backend units 26/26. |
| 2026-07-16 | 2.1 | `p2.1: migration 005 — org_integrations table (per-org encrypted creds)` | Table (org_id, provider) PK, provider CHECK IN ('jira','github'), ciphertext TEXT NOT NULL (opaque envelope — no plaintext ever), key_version INT default 1 (rotation/KMS seam), created_at/updated_at + touch_updated_at trigger (matches 001 convention; plan's raw SQL omitted the trigger). **Renumbered 004→005** (004 = developers_email, 1.7). Applied + idempotent (2nd run 0 pending); schema verified via information_schema/pg_constraint/pg_trigger. Migration-only, zero app code touched → backend units 26/26; full smoke deferred to first code-bearing step (2.4 mounts a reader). |
| 2026-07-15 | 1.4 | `p1.4: backend enforcement — default-closed /api auth gate, socket verifyToken, internal lane` | clerkMiddleware (fail-fast w/o CLERK_SECRET_KEY); **default-closed gate on /api** (allowlist: /health + /db/health open, /db/standups→orgOrInternal, rest→requireOrg). ARCHITECTURE NOTE: guards must NOT be mount-level or router.use — flat '/api' mounting means every request enters every router, so any router-level guard intercepts other routers' routes (found live: epics guard 401'd the bot lane). Consequence: unmatched /api/* now 401 unauthed (default-closed). Socket io.use verifyToken (v2 `o.id` + v1 org_id claims). Bot sends X-Internal-Key + X-Org-Id (STANDUP_ORG_ID). Backend .env +CLERK_PUBLISHABLE_KEY; INTERNAL_API_KEY generated + set in all 3 service .envs. smoke-test.mjs reworked: authz section (always, unauthed, expects 401s) + SMOKE_AUTH_TOKEN-gated authed sections + SMOKE_INTERNAL_KEY lane check. /api/standup/* = plain requireOrg (tighter than plan's orgOrInternal — no internal caller exists). |
| 2026-07-16 | 2.5 | `p2.5: jiraService → per-org client factory; Jira routes resolve creds by org` | jiraService.js → `createJiraClient({domain,email,apiToken})` returning all 28 methods closed over those creds (mechanical closure-ization; signatures/behavior unchanged). Pure exports stay module-level: `generateProjectKey`, `isDoneCategory`, helpers (parseJiraError/mapIssue/extractStoryPoints) internal. New services/jiraClientFor.js: `jiraClientFor(orgId)` → provider creds → client, throws IntegrationNotConnectedError('jira'). routes/jira.js + sync.js: every handler resolves `const jira = await jiraClientFor(req.orgId)`; **zero `process.env.JIRA_*` reads left in backend src**. 412 mapping: new `sendNotConnectedIfApplicable` checked first in both sendServerError/sendUpstreamError + global error middleware → `412 {success:false,error:'JIRA_NOT_CONNECTED'}`. **Contract changes:** field-discovery cache now per-domain (`Map<domain,…>`, 10-min TTL); `getSprints` REQUIRES boardId (global JIRA_BOARD_ID fallback gone) so `GET /api/jira/sprints` 400s without `?boardId` (dead code — `useSprints` has no consumer; `useBoardSprints`/`/board/:id/sprints` is what the app uses); `/jira/health` domain now from stored org creds. **Adversarial review (9 agents, 5 lenses: parity/callsites/errorpath/consumers/multitenancy) → 1 confirmed finding, FIXED in-commit:** discoverFields' catch cached the hardcoded fallback field ids under the shared domain key, so ONE org's 401 (revoked token) poisoned every org on that domain for 10 min (silent storyPoints:null, burndown degraded to count-mode, updateStoryPoints 500s, epic-link failures on team-managed projects) — failure path no longer caches; only successful discovery is cached. 3 findings refuted. Verified: 28/28 client methods present, IntegrationNotConnectedError→412 on both helper paths, ordinary Jira errors still 500+message (SyncButton warnings contract intact), factory + getSprints input validation. Units 26/26; smoke 27 PASS/0 FAIL (bot+frontend not booted → optional skips). Live Jira sync E2E = G2 (needs a connected org via 2.7 UI). |
| 2026-07-16 | 2.6 | `p2.6: githubService → per-org token; developer refresh per-org` | githubService.js → `createGithubClient(token)` returning `{analyzeDeveloper}` with the credential-bound fetchers (fetchUserRepos/fetchRepoCommits/fetchCommitDetails) closed over the org's headers; pure helpers (analyzeCommits/checkRateLimit/sleep) stay module-level. **Token now REQUIRED** — factory throws without one (no silent unauthenticated 60-req/hr mode, which one analysis exhausts). New services/githubClientFor.js → `githubClientFor(orgId)`, throws IntegrationNotConnectedError('github'). routes/developers.js resolves the client ONCE before the analyze loop → 412 `GITHUB_NOT_CONNECTED` before any work (via 2.5's sendServerError mapping). **Zero `process.env.GITHUB_TOKEN` reads left in backend src.** developerRefresher split: `refreshDevelopersForOrg(orgId)` (one org, its own token) + `refreshAllDevelopers()` (cron: `SELECT DISTINCT org_id FROM developers`, per-org client, orgs without GitHub skipped with ONE log line + counted as `skipped`, never failed). **Tenancy fix found here:** `POST /api/db/developers/refresh` is org-scoped but called `refreshAllDevelopers()` — harmless with one global token, but with per-org tokens org A's button would refresh (and burn the GitHub rate limit of) every other org. Now calls `refreshDevelopersForOrg(req.orgId)`; the cron keeps the all-orgs sweep. Summary gains `skipped` (additive; frontend spreads the object). Verified live: 9/9 — not-connected→412 on the real handler path, factory rejects empty token, cron over the real DB skips the user's org cleanly (total=3 updated=0 failed=0 skipped=3, one log line for 3 devs). Units 26/26; smoke 27 PASS/0 FAIL. Live GitHub analyze E2E = G2 (needs a connected org via 2.7 UI). |
| 2026-07-16 | 2.7 | `p2.7: Settings → Integrations UI; graceful not-connected states` | **Plan drift:** `pages/jira/Settings.jsx` doesn't exist (nor Kanban/Reports pages, nor a `/settings` route — CLAUDE.md's file map is stale) → **created** `pages/Settings.jsx` + route + Sidebar "Configuration → Integrations" (Plug icon). Two cards (Jira: domain/email/API token + id.atlassian.com link; GitHub: PAT + scopes note + token link), each with status badge (Connected as `email` on `domain` / `login` + token last-4 — never the token), Connect/Update · Test connection · Disconnect (confirm dialog). Non-admins: inputs+buttons disabled + "Admin access required, ask an org admin" panel (backend `requireOrgAdmin` is the real gate; `ORG_ADMIN_REQUIRED` → friendly copy). Tokens **write-only**: inputs start empty, show `••••` placeholder when connected, never populated from the server. New `hooks/useIntegrations.js` (SWR `GET /api/integrations`, **keyed by org id** so org-switch refetches; exposes isAdmin from Clerk `membership.role`). `lib/api.js`: new `ApiError {status, code}` + `apiJson()` + `humanizeError()`; `.notConnected` getter = 412 + `*_NOT_CONNECTED` so callers branch on intent, not string matching. New `components/shared/NotConnected.jsx` (full + compact variants → CTA to /settings). Wired: `useSprintData` fetcher → apiJson (ApiError to all SWR consumers); `useKanbanSync` splits `jiraNotConnected` out of `connectionError` → KanbanBoard renders the CTA instead of a red "Unable to connect / Retry" banner; ProjectDetailPage synced view banners when Jira was disconnected after sync (explains the empty charts); SyncButton disables + tooltips + inline CTA when Jira not connected (never gates on unloaded status — backend 412 stays the authority); Step3/AssignPage/DevelopersPage show the GitHub CTA before analyzing and humanize `GITHUB_NOT_CONNECTED` (was surfacing the raw code as the error message). Theme conventions honored — caught + fixed my own use of non-existent `text-accent`/`bg-accent` (tailwind `accent` is a nested object: accent.cyan/lime/...) → repo's real `bg-blue-600`/`text-blue-600` + semantic utilities. Contracts verified against routes/integrations.js (`{domain,email,apiToken}` / `{token}`, `/test` POST, `:provider` DELETE, `org:admin`). Build 15.1s + frontend units 18/18; bundle carries no token patterns. **Interactive walk of the matrix (no integrations / jira only / both) + non-admin 403 = G2 (needs USER to connect a real Jira).** |
| 2026-07-16 | 2.8 | `p2.8: kill global Jira/GitHub env vars; document the per-org model` | backend/.env.example: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_BOARD_ID/GITHUB_TOKEN removed, replaced by a note pointing at the Integrations UI + CREDENTIALS_MASTER_KEY. CLAUDE.md: backend env block rewritten (the real required set: DATABASE_URL/CLERK_SECRET_KEY/CREDENTIALS_MASTER_KEY/INTERNAL_API_KEY) + **new "Per-Org Integrations" architecture section** (resolution chain routes→clientFor→credentialProvider→org_integrations→factory; never read process.env.JIRA_*/GITHUB_TOKEN; 412 contract; write-only creds; admin-only writes; master-key fail-fast; D6 bot exception) + new Jira rule pinning the per-domain cache/don't-cache-failures invariant from 2.5; killed the stale "Jira integration requires valid credentials in backend/.env" line. README: setup step 7 = connect from the app, and step 3 notes Jira/GitHub aren't env vars. **Did NOT touch the user's local backend/.env** — those dead entries still hold the live Jira/GitHub credentials the user needs to PASTE into the Settings UI at G2; deleting them first would destroy the values. User deletes them after connecting (per plan spec, flagged in handoff). **Verify:** booted the server with all 5 legacy vars force-deleted from the environment → /api/health 200, /api/jira/sprints 401, /api/analyze-developers 401 (gate holds, no crash, no missing-config error); `.env.example` + backend source greps clean; standup-bot's own JIRA_* untouched (4 vars, D6). |
| 2026-07-16 | harness | `test: Phase-2 regression expectations — crypto units + per-org 412 contract` | **G2 item 6.** Backend units 26→**32**: new `test/cryptoService.test.js` promotes the envelope checks into the unit run (round-trip, opacity, shape, payload-tamper, DEK-tamper, wrong-master-key reject) with an ephemeral key so it's hermetic on a fresh checkout (`scripts/crypto-selftest.js` stays as the standalone script). smoke-test.mjs: `jiraChecks` → **`integrationChecks`** — reads `GET /api/integrations` first (asserting the status payload carries NO token material), then asserts whichever contract applies to the token's org: **not connected → 412 JIRA_NOT_CONNECTED (sprints) + 412 on sync-jira + 412 GITHUB_NOT_CONNECTED (analyze-developers)**; **connected →** boards→sprints?boardId read path + `sprints` without boardId → 400 (pins 2.5's removal of the global board-id fallback). Both branches are correct outcomes, neither is a regression. Killed the stale "without JIRA_BOARD_ID Jira returns 400 → WARN" comment and the old `ok !== false` health assertion (health never returned `ok`). Header documents the per-org era. Safety unchanged: the sync-jira probe only runs on the not-connected branch (412s before any Jira call; `createJiraClient` is network-free). Unauthed smoke 27 PASS/0 FAIL; the 412 branches need SMOKE_AUTH_TOKEN → they fire at G2 (same as every authed section since G1). |
| 2026-07-16 | harness-fix | `test: make Flask/bot HTTP tests independent of the local .env` | **Found the Python suites RED while running the full G2 harness — 5 Flask + 1 bot failures, all `401 != 400`.** Not a Phase-2 regression (my commits touch zero Python; tests date from 0.4/baseline): the internal-key gate (0.3) reads `INTERNAL_API_KEY` at import, step **1.4 set that key in all 3 service .envs**, and these validation tests never sent `X-Internal-Key` → every validation path 401s before reaching validation. So the suites' result depended on whether the developer's .env had the key — G1 logged 21/21 because it was run without it loaded. This is the same env-drift class 2.4 fixed **in the smoke harness only**; the unit suites were missed. Fix: validation tests present the key when configured (targets validation, not the gate); health stays keyless (proves the exemption); **+1 test per service asserting the gate 401s when a key IS configured** (skips when unset) — the gate is now covered rather than accidentally exercised. Flask **22/22**, bot **10/10** (baselines updated). |
| 2026-07-16 | 3.1 | `p3.1: Dockerfiles + compose (prod parity)` | 4 Dockerfiles + root `docker-compose.prod.yml` + 4 `.dockerignore`s + frontend `nginx.conf` + root `.env.example` + `.gitattributes`. Backend: node:22-alpine multi-stage (deps `npm ci --omit=dev` → runtime), non-root `node` user, `docker-entrypoint.sh` runs `migrate` then `exec` server (idempotent via schema_migrations; `set -e` so we never serve a half-migrated DB), HEALTHCHECK on /api/health. Flask + bot: python:3.12-slim, non-root appuser, **waitress not gunicorn** (deviation from the spec's "gunicorn", justified: already the dep + documented in both apps' banners, and the bot runs APScheduler in-process so `gunicorn -w N` would fire every daily reminder N times — single waitress process = scheduler runs once; --channel-timeout=300 covers slow Gemini). Bot: **+1 code line** `STANDUP_DATA_FILE` env override (mirrors 0.9's __file__+argv pattern) so a compose volume at /app/data persists standups not yet flushed to Postgres; VOLUME + chown before USER-drop. Frontend: build stage takes PUBLIC `VITE_*` build args (baked into bundle) → nginx:alpine with SPA `try_files … /index.html`, `/assets` immutable cache, and `/api` + `/socket.io` (WS upgrade) proxy to `$backend` **with `resolver 127.0.0.11`** — a variable in proxy_pass needs a resolver or nginx won't start (real gotcha, fixed pre-commit). Compose: postgres:16-alpine (pgdata volume, pg_isready healthcheck) → backend (`depends_on: service_healthy`, DATABASE_URL/FLASK_URL/FOCUS_FLOW_URL set to compose service names in `environment:` so per-service .envs stay host-agnostic) → flask/bot (internal-only, **no published ports**) → frontend (nginx, published). Only frontend+backend expose host ports. `.gitattributes` forces LF on *.sh/Dockerfile/nginx.conf (CRLF breaks the container shebang). **`docker` unavailable on this machine → live `docker compose up --build` deferred to a Docker host / Fable.** Statically verified: compose YAML parses (5 services, only backend+frontend published, `service_healthy` gate, pgdata+botdata volumes), both npm lockfiles present for `npm ci`, root `.env` gitignored, entrypoint stored as LF (`git check-attr eol`), bot py_compile + units 10/10 (env override falls back to identical default). |
| 2026-07-16 | 3.2 | `p3.2: structured logging + request IDs (pino/pino-http; Flask/bot LOG_LEVEL)` | Backend: new `logger.js` = pino (LOG_LEVEL env, ISO timestamps, `service:backend` base) + pino-http. `httpLogger` mounted first: `genReqId` honors inbound `X-Request-Id` else mints a UUID, echoes it on the response header, and attaches a per-request child logger at `req.log` (all a request's lines share `req.id`); health/ready ignored in autoLogging so probes don't flood. **Redaction** (the real safety net): `authorization`/`cookie`/`x-internal-key`/`x-admin-key` headers + `apiToken`/`token`/`apiKey`/`password` (top-level and `*.`nested) → `[redacted]`. Swept console.* → logger in server.js (13), db.js (4), utils/httpError.js (2 → prefer `res.req.log`), routes/sync.js (41: line-102 helper→module `logger`, rest→`req.log`), routes/jira.js (6→`req.log`). Deep service console.logs left as pragmatic follow-up (per spec). Flask + bot: `logging.basicConfig(level=LOG_LEVEL default INFO, timestamped)` — also governs Werkzeug/APScheduler logs — + a module `log`; level-tagged prints (`[ERROR]`/`[WARN]`/`[INFO]`/`[SUCCESS]`/`[DEBUG]`) converted to `log.*` (7 flask, 21 bot), ASCII startup banners left as prints. **Verified LIVE:** boot emits JSON lines; a request with inbound `X-Request-Id: trace-abc-123` → that id on the request log line AND echoed on the response `X-Request-Id` header; an `Authorization: Bearer ATATT…` token → `"authorization":"[redacted]"` in the log (never the token); direct logger test redacts `apiToken`/`token`/`password` in body + nested (the integration-save leak path). Units all green: backend 32, flask 22, bot 10. Deps: pino@9 + pino-http@10. |
| 2026-07-16 | 3.3 | `p3.3: /api/ready readiness probe (pg check) + probe docs` | server.js: new open `GET /api/ready` — `pingDb()` → `200 {status:'ready',db:true}` / `503 {status:'not ready',db:false}`. Registered next to `/api/health`, before the rate limiter + auth gate (never throttled/blocked); already in httpLogger's autoLogging ignore. Semantics documented inline: **health = liveness (no deps → restart signal)**, **ready = readiness (deps → LB traffic gate; pull a DB-less instance instead of killing it)**. Flask + bot keep their `/api/health` (unchanged, per spec). Probe paths documented in `docker-compose.prod.yml` (backend service comment); container HEALTHCHECK stays on /api/health (liveness). smoke-test.mjs: +open-probe assertion `GET /api/ready → 200 {db:true}` (same-commit contract add). **Verified LIVE, both branches, without touching the user's Postgres:** live instance (DB up) → health 200 + ready 200 {db:true}; 2nd instance booted with an UNREACHABLE DATABASE_URL (`…@127.0.0.1:5999`, lazy pool so no boot fail-fast) → health stays **200** while ready is **503 {db:false}**. Full smoke 28 PASS/0 FAIL. |
| 2026-07-16 | 3.4 | `p3.4: CI — build + secret scan on push/PR` | New `.github/workflows/ci.yml`, 4 parallel jobs (concurrency-cancel on same ref): **frontend** (node 22, npm ci, npm run build), **backend** (npm ci, `node --check server.js`, `npm test` — verified the suites run WITHOUT a DB, so no Postgres service needed; a stray db.js import would fail-fast, itself a useful signal), **python** (setup 3.12, `py_compile` web_app.py + app.py — no deps since py_compile doesn't import), **secret-scan** (grep-based, no gitleaks-action/license: `git grep -nIE` real token shapes WITH length quantifiers — ghp_/github_pat_/ATATT/xox[baprs]-/AIza/sk_(live|test)_ — excluding *.md/*.lock/package-lock.json/.github/**; pk_live/pk_test publishable keys intentionally NOT scanned). **Verified locally before push:** ci.yml YAML parses; `npm test` green with DATABASE_URL unset (32/32); secret grep = clean on the tree, does NOT self-match the workflow's own regexes (literal brackets ≠ quantified alnums), and DOES catch a fake `ghp_`+36 token (the plan's negative test). Live GitHub Actions run confirmed after push: run 29598660217 on commit `52f6f75` → **conclusion success, all 4 jobs green** (Frontend build: npm ci + build; Backend: npm ci + node --check + npm test; Python compile; Secret scan) — queried via the public Actions API (no gh CLI on this box). |
| 2026-07-16 | 3.7 | (CLAUDE.md is gitignored — local-only, no commit; auto-loads each session) | Rewrote the stale post-migration sections of `.claude/CLAUDE.md`. **State Management**: Auth → Clerk (orgs, membership-required, ClerkProvider/AuthGuard/OrganizationSwitcher; old fake login + `focus-flow-auth` deleted in 1.8); Projects/Developers/Retros → Postgres via `/api/db/*` org-scoped (was localStorage) with the `useProjects` context / SWR shapes; kept theme + wizard-drafts as the only legitimate localStorage (D4) + an explicit "localStorage now holds ONLY …" line. **Service run commands**: local (node/venv python per service, incl. the standup bot as the 4th) + production (`docker compose … up --build`, waitress for Flask, nginx for the frontend, internal-only Flask/bot) + probe paths (health=liveness, ready=readiness). The env block + Per-Org Integrations architecture were already fixed in 2.8. Conventions/architecture-diagram/API-contract sections kept. **Verify:** grep confirms zero `admin/1234` (literal gone, not just negated), zero localStorage-as-source-of-truth for projects/developers, zero `JIRA_API_TOKEN=` config claim; bot service documented (run cmd + env). |
| 2026-07-16 | 3.5 | `p3.5: hosting decision D3 = Managed PaaS; DEPLOYMENT.md runbook` | **USER decision: Managed PaaS** (recommended option — lowest ops burden for a solo launch: auto-TLS, managed PG backups, no server to patch). New `DEPLOYMENT.md`: prod architecture + reachability (frontend/backend public; **Flask internal-only**; **bot public for `/slack/*` only**, gated elsewhere — the one nuance vs compose's all-internal); master-key backup warning up top; secret-gen commands; managed-PG (`DATABASE_SSL=true`, auto-migrate via entrypoint); **Clerk PROD instance** checklist (pk_live/sk_live to the right places, allowed origins, dev orgs don't carry over); per-service deploy tables (§4–7); **Slack prod URL updates** (events/command/interactivity → bot prod host, re-verify); SPA rewrites (Vercel/Netlify) + the split-origin CORS wiring (VITE_API_URL=backend, CORS_ORIGINS=frontend); **post-deploy smoke checklist** (health/ready, 401 sweep, WSS, sign-up→wizard→save E2E, integration connect + sync, two-org isolation, no mixed-content, JSON logs no-tokens, Lighthouse). Single-VPS+Compose kept as Appendix B (same Dockerfiles). Appendix A of the plan updated with the Phase-3/model-fix vars (`CLERK_PUBLISHABLE_KEY`, `LOG_LEVEL` ×3, `GEMINI_MODEL` ×2, `STANDUP_DATA_FILE`, root-compose block). **Verify:** scripted check — all 39 distinct Appendix-A env vars appear in DEPLOYMENT.md; decision recorded here. Deploy execution = 3.6 (user's accounts/DNS). |

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
| 2026-07-15 | 0.8 | ✓ | `npm run migrate` run1 = "1 pending" applied 001_init.sql; run2 = "0 pending"; schema_migrations shows 001_init.sql with applied_at. Idempotent + transactional confirmed. |
| 2026-07-15 | 0.9 | ✓ | `git grep c:/Users` in tracked non-md source → none; import-standups.js node --check OK; all 4 .env.example files contain their full Phase-0 var set (scripted presence check passed). |
| 2026-07-15 | 1.1 | ✓ | pk decodes to instance domain; sk live 200 on /v1/users; /v1/organizations 200 after user enabled orgs (membership-required mode) |
| 2026-07-15 | 1.2 | ✓ | Build + 18/18 units; user interactive test: signup→org→app OK, caught dead Sidebar logout (fixed → useClerk().signOut()); adversarial workflow (8 agents): 3 confirmed findings — logout (fixed), dark-mode CSS (fixed), localStorage cross-account leak (assigned to 1.7 w/ rationale) |
| 2026-07-15 | 1.4 | ✓ | Unauthed sweep: 14/14 business endpoints → 401; internal lane X-Internal-Key → 400 (reaches validation); /api/health + /api/db/health → 200; smoke 20 PASS/1 FAIL (Flask not booted — not a defect); backend units 26/26. Caught + fixed live: mount-level guard bug (see exec log). Full authed interactive E2E = user's browser at G1. |
| 2026-07-15 | 1.5 | ✓ | migrate applied 002 idempotently; org_id column on all 5 tables (information_schema); backfill counts printed per table; standups 37/37 with org. |
| 2026-07-15 | 1.6 | ✓ | **HTTP isolation test**: standup written as org B (201) → visible to B (1 row), INVISIBLE to real org (0 rows) → cleanup; write w/o X-Org-Id → 400. org_id NOT NULL on all 5 tables; developers PK = (org_id, username) (pg_index). Units 26/26; smoke 20 PASS/1 FAIL (Flask down only). Two-browser projects isolation = G1. |
| 2026-07-15 | 1.7 | ✓ | Build 12.9s + 18/18 units; migration 004 applied; internal lane + enforcement re-verified post-restart; interfaces byte-compatible (consumers untouched); leak finding closed (state cleared on sign-out/org-switch, no tenant localStorage). Interactive persistence check = G1. |
| 2026-07-15 | 1.8 | ✓ | AuthContext.jsx deleted; AuthProvider unmounted from App.jsx; grep for AuthContext / focus-flow-auth / admin+1234 across src → zero; build 12.4s + 18/18 units. |
| 2026-07-16 | G1 | ✓ | **USER-CONFIRMED interactive E2E**: sign-up → org → wizard (AI generate working) → save → persists across refresh/browsers; second account + second org sees EMPTY workspace (isolation). Scripted side: 401 sweep, socket auth, internal lane, units 26+18+21+9, smoke green. Finding during G1: import-from-browser banner offered user A's legacy localStorage projects to user B → **import feature removed entirely**, dead legacy keys purged on app start, test projects cleared from DB (user request). Phase 1 COMPLETE. |
| 2026-07-15 | model-fix | ✓ | gemini-2.5-flash-lite → 404 for new keys (caught by G0 smoke). Fixed: GEMINI_MODEL env, default gemini-2.0-flash. Request now reaches Gemini; generation blocked only by free-tier quota (429). |
| 2026-07-15 | model-fix-2 | ✓ | **User's suggestion (use lite) was correct.** Probed all lite variants: flash-lite-latest=200, 3.1-flash-lite=200, 3.1-flash-lite-preview=200, 2.0-flash-lite=429. Default → `gemini-flash-lite-latest` (free quota + alias never 404-deprecates). Full `--ai` smoke: **25 PASS / 0 FAIL** — 4 epics + stories generated end-to-end; parser handles new model output. G0 Gemini caveat CLOSED without billing. Billing still recommended before real client load (D5/Phase 3). |
| 2026-07-16 | G2 (partial) | ✓ | **USER connected Jira + GitHub through the new Integrations UI** (org_3GXt…kPn). Verified live, not trusted: `org_integrations` holds 2 rows (jira 557B / github 297B ciphertext, kv=1); **ciphertext opaque** (no `atlassian.net`/`ATATT`/`ghp_`/`@` markers); stored Jira creds authenticate against `/rest/api/3/myself` → "Moiz Danish @ moix3838.atlassian.net", 3 boards readable; stored GitHub token authenticates `/user` → login=moizkhan38, scope=repo, and **stored login matches live login**; `getStatus` carries zero token material; backend logs scanned for `ATATT|ghp_|github_pat_|Basic <b64>|apiToken` → **clean**. **Isolation (service layer):** a foreign org gets `null` from getJiraCredentials/getGithubToken, `connected:false` status that cannot see org A's domain/login, and `JIRA_NOT_CONNECTED`/`GITHUB_NOT_CONNECTED` from both clientFor helpers. **PAT follow-up from 0.1 CLOSED:** user first connected the chat-exposed PAT (caught by comparing stored↔.env without materializing either), then regenerated + used the card's Update flow — new token authenticates live, **old PAT now 401s at GitHub (genuinely revoked)**, `updated_at` moved (migration 005's touch trigger re-encrypted in place). **2.8 user action DONE:** the 5 dead lines removed from local backend/.env; backend restarted on the cleaned file and re-verified — all 5 vars absent from `process.env`, Jira/GitHub still fully functional **from the encrypted per-org store alone**. Remaining for G2: sync E2E (creates a real Jira project + sends real invite emails — user-driven), authed smoke connected-branch, non-admin 403. |
| 2026-07-16 | **G2** | ✓ | **PHASE 2 COMPLETE — user-confirmed sync E2E, verified against live Jira (not trusted).** User ran wizard→assign→Sync to Jira on org A. Verified from the DB + their Jira Cloud: project **TP1** `status=synced` (board=68, sprint=36 persisted); board 68 auto-created and **type=scrum**; sprint 36 active 2026-07-16→23 holding **all 4 stories**; **story points set 4/4 (3,2,5,3)** — this is the exact path 2.5's field-cache bug would have broken, so per-domain discovery resolved the right customfield on a real instance; assignees 3/4. **The 1 unassigned is a data condition, not a defect:** only `moizkhan38` has an email on the roster (Saqibnawazkhan/Musak7 have none) → unresolvable to Jira accounts → documented `warnings[]` path. Gate items: (1) all steps verified ✓ (2) two-org isolation ✓ — foreign org gets null creds, `connected:false`, cannot see org A's domain/login, `*_NOT_CONNECTED` from both helpers; HTTP 412 mapping verified directly on the handler helpers (3) full E2E ✓ above (4) secret hygiene ✓ — ciphertext opaque, `getStatus` clean, backend logs scanned clean (5) **zero JIRA_*/GITHUB_TOKEN reads ✓ — proven by restarting on the cleaned .env: all 5 vars absent from process.env and Jira/GitHub still fully functional from the encrypted store alone** (6) harness green ✓ — 82 units (backend 32 / frontend 18 / flask 22 / bot 10) + smoke 28 PASS/0 FAIL. **Residuals (deliberately not blocking):** non-admin→403 needs a 2nd org member (backend gate is unit-covered + 403 path verified directly); the invite-by-email path never fired (the one email-bearing dev already has a Jira account — no subject to invite); authed-smoke connected-branch not run (needs a 60s browser token — its assertions were verified equivalently by hand: 3 boards→sprints readable). **Found while verifying (pre-existing, NOT Phase 2):** the `assignments` table is never written by the app — its org-scoped API from 1.6 has no caller; assignments persist in `projects.raw` JSONB (verified: 4 correct entries). No data at risk; dead weight to clean up in Phase 3/4. Also stray: Jira auto-creates an empty dateless "TP1 Sprint 1" with every new Scrum board (not ours, benign). |
| 2026-07-15 | **G0** | ✓* | Full stack booted (Express+Flask+bot). Smoke: **24 PASS / 1 FAIL**; the FAIL is [ai] generate blocked by Gemini **free-tier quota (429)** — external, not a code defect (path + error-handling verified). Secret scan clean; `.env` never committed; forged /slack/events=401, /test/reminder=404, hostile Origin no-ACAO, rate-limit 429; `npm run build` OK, zero localhost in bundle. **CAVEAT (root cause confirmed):** new-user Gemini projects have free-tier `limit: 0` (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, verified via 429 body) — the old key was grandfathered. Waiting for reset will NOT help. Fix: enable billing on the key's project (D5 pulled forward), or mint a key inside the ORIGINAL grandfathered project if it still exists. |
