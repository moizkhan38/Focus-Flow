# Focus Flow — Session Handoff (as of 2026-07-16)

**Read this first, then `PRODUCTION-PLAN.md` (the master plan + execution/verification logs).**
This file exists so a fresh agent can continue without re-deriving anything.

## What this project is

Focus Flow — AI-powered Scrum automation being converted from a localhost demo into a
**multi-tenant SaaS** where each client organization connects its own Jira + GitHub.
Repo root: `c:/Users/user/Documents/Integretion/integration` (git → github.com/moizkhan38/Focus-Flow---AI-Powered-Scrum-Master-Automation-Tool, PUBLIC).

Four services (all env-driven, see `.env.example` files):
| Service | Port | Run (dev) |
|---|---|---|
| Express API gateway | 3003 | `epic-dev-assignment/backend` → `node server.js` |
| Flask epic-generator (Gemini) | 5000 | `epic-generator` → `venv/Scripts/python.exe web_app.py` |
| Slack standup bot | 3000 | `standup-bot` → `.venv/Scripts/python.exe app.py` |
| React 19 + Vite frontend | 5173 | `epic-dev-assignment/frontend` → `npm run dev` |

**Boot pattern that survives session restarts** (bash background tasks die with the CLI):
PowerShell `Start-Process -WindowStyle Hidden` with `-WorkingDirectory` per service.
Postgres 18 runs as a Windows service (`postgresql-x64-18`), db `focusflow`.

## Where we are: Phase 0 ✅ G0 ✅ Phase 1 ✅ G1 ✅ — next is PHASE 2

**Phase 0 (p0.0–p0.9)** — hardening: all 5 leaked secrets rotated + verified live; hardcoded
DB password removed (was in git history — rotated, moot); Flask debug-RCE killed + internal-key
gate; bot Slack-signature verification + daily (not 2-min) reminders + gated /test/*; Express
trust-proxy/rate-limit/global error handler/graceful shutdown/advisory-lock cron; error-leak
sweep (`sendServerError`/`sendUpstreamError` in `utils/httpError.js`); frontend env-driven
API base (`lib/api.js`, `VITE_API_URL`); migration runner with tracking table + transactions.

**Phase 1 (p1.1–p1.8)** — accounts + tenancy (all user-verified at G1):
- **Clerk** auth (decision D2): instance `handy-gannet-17.clerk.accounts.dev`, Organizations
  ENABLED with **membership required**. Frontend: ClerkProvider in `main.jsx` (fail-fast),
  `/login/*` + `/signup/*` (path routing), `AuthGuard` = SignedIn/SignedOut + OrgGate,
  OrganizationSwitcher + UserButton in Header AND Sidebar, Sidebar logout = `useClerk().signOut()`.
- **Token layer**: `lib/api.js` `apiFetch` attaches fresh Clerk JWT per request (registered via
  `lib/AuthBridge.jsx`); socket auth-as-function re-sends fresh token per (re)connect.
- **Backend enforcement**: `clerkMiddleware` + **ONE default-closed gate on /api** in `server.js`.
  ⚠️ ARCHITECTURE RULE: never attach auth at mount level or via `router.use` in the business
  routers — ALL routers share the flat `/api` mount, so every request enters every router and
  a router-level guard intercepts OTHER routers' routes (this bug happened live; the gate fixed
  it). Allowlist: `/api/health` + `/api/db/health` open; `/api/db/standups` → `orgOrInternal`
  (bot lane: `X-Internal-Key` + `X-Org-Id`); everything else → `requireOrg` (401/403).
  Unmatched /api paths return 401 unauthed by design. Socket handshake: `verifyToken`
  (v2 `o.id` / v1 `org_id` claims); room joins validated against `projects.org_id`.
- **Tenancy**: migrations 002/003/004 — `org_id TEXT NOT NULL` on all 5 tables, developers
  PK = `(org_id, username)`, `developers.email` column. EVERY query in `routes/db.js` is
  org-scoped; projects upsert blocks cross-org id collisions (409); assignments bulk verifies
  project ownership (403). Isolation proven over live HTTP + user's two-account browser test.
- **Server-backed data (1.7)**: `useProjects` (context; optimistic + per-project 800ms debounced
  saves; full client object in `raw` JSONB; refetch on org switch; clears on sign-out),
  `useDevelopers`/`useRetro` (SWR shared cache). Interfaces byte-identical to the old
  localStorage versions — consumers untouched. localStorage now holds ONLY theme/wizard-drafts/
  templates. Import-from-browser feature was added then **REMOVED** (it leaked user A's legacy
  data to user B on shared browsers — found in G1); dead legacy keys are purged on app start.
- Legacy `AuthContext`/admin-1234 deleted entirely (1.8).

**Data right now**: org `org_3GXtieh7StRfNyu70R5nTQCgkPn` ("Moiz's Organization") owns
3 developers + 37 standups. Projects table intentionally EMPTY (test data cleared on request).
A second test account/org exists in Clerk (from isolation testing).

## Gemini situation (important context)

Old grandfathered key was rotated (leak) → new keys/projects have **free-tier limit: 0** on
older models and 404 "not available to new users" on `gemini-2.5-*`. Working solution (user's
idea): **`gemini-flash-lite-latest`**, configurable via `GEMINI_MODEL` env in both
`epic-generator/.env` and `standup-bot/.env` (code default is that alias). Verified generating.
**Before real client load: enable billing on the Gemini project** (decision D5 — platform-owned key).

## Secrets & env (never print values; verify from files)

All real values live ONLY in gitignored `.env` files (backend, epic-generator, standup-bot,
frontend/.env.local). `.env` was never committed (verified). All 5 credentials rotated 2026-07-14
and verified against live APIs. `INTERNAL_API_KEY` is one shared value across the 3 backend
services (Express↔Flask↔bot lanes). `CLERK_SECRET_KEY` (backend/.env) + `VITE_CLERK_PUBLISHABLE_KEY`
(frontend/.env.local) + `CLERK_PUBLISHABLE_KEY` (backend/.env). Bot binds `STANDUP_ORG_ID` to the
user's org.
**PENDING FOLLOW-UP**: the GitHub PAT was once pasted into chat during setup — user should
regenerate it one more time (3-min task, non-blocking; noted in plan exec log).

## Test / verification harness

- `node smoke-test.mjs` from repo root — unauthenticated mode asserts the 401 enforcement
  sweep; `SMOKE_AUTH_TOKEN=<clerk-jwt>` (from browser: `await window.Clerk.session.getToken()`,
  expires ~60s) unlocks authed sections; `SMOKE_INTERNAL_KEY=<key>` tests the bot lane;
  `--ai` runs one real Gemini generation. See `TESTING.md`.
- Unit suites: backend `npm test` (26), frontend `npm test` (18), Flask
  `venv/Scripts/python.exe -m unittest discover -s tests` (21), bot same with `.venv` (9).
- Rule: any intentional contract change must update the harness IN THE SAME COMMIT.

## Working conventions with this user

- **PRODUCTION-PLAN.md is the single source of truth** — statuses `[ ]`/`[x]`/`[✓]`, Execution
  Log + Verification Log; one step = one commit `p<phase>.<step>: summary`; push after commit
  (auto-commit policy in `.claude/CLAUDE.md`).
- USER-ACTION steps (external consoles): give click-by-click walkthroughs; expect small
  missteps (wrong password pasted, placeholder not replaced) — verify each step from files/
  live APIs yourself rather than trusting "done". Secrets go into files, never chat.
- The user tests interactively and reports bugs tersely ("logout button is not working") —
  these reports have been consistently accurate and valuable.
- Windows quirks: bash background tasks report exit 127 when killed externally (not a real
  failure); CRLF warnings on commit are noise; use `curl.exe`/PowerShell carefully re quoting.

## NEXT: Phase 2 — per-org Jira & GitHub (the SaaS core), steps 2.1–2.8

Global `JIRA_*`/`GITHUB_TOKEN` env creds must die; each org connects its own via Settings UI.
Per the plan: 2.1 `org_integrations` table (migration 005 — note: 004 is taken by developers.email)
→ 2.2 envelope-encryption `cryptoService` (AES-256-GCM, per-secret DEK wrapped by
`CREDENTIALS_MASTER_KEY` env; KMS-ready seam) → 2.3 `credentialProvider` (TTL cache,
`IntegrationNotConnectedError`) → 2.4 integrations API (admin-only writes via `orgRole`,
test-before-save against Jira/GitHub, never return tokens) → 2.5 `jiraService` → per-org client
factory (biggest refactor; per-domain field cache; callers in routes/jira.js + sync.js; 412
`JIRA_NOT_CONNECTED`) → 2.6 `githubService` per-org token + per-org `developerRefresher`
(412 `GITHUB_NOT_CONNECTED`) → 2.7 Settings UI (connect cards, status, not-connected empty
states, SyncButton tooltip) → 2.8 remove global cred envs. Gate G2 = two-org integration
isolation + full Jira sync E2E on org A while org B gets 412s.

Decisions locked: D1 encrypted tokens now/OAuth Phase 4 · D2 Clerk · D3 hosting deferred ·
D4 Postgres persistence · D5 platform Gemini key · D6 bot single-workspace v1.
