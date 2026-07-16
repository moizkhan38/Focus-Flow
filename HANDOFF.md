# Focus Flow — Session Handoff (as of 2026-07-16)

**Read this first, then `PRODUCTION-PLAN.md` (the master plan + execution/verification logs).**
This file exists so a fresh agent can continue without re-deriving anything.

> ⚠️ **`.claude/CLAUDE.md` IS STALE.** It auto-loads into your context and still describes
> the PRE-MIGRATION app: localStorage persistence, `admin/1234` login, global `JIRA_API_TOKEN`
> env creds, no auth on the API. Where it conflicts with this file or PRODUCTION-PLAN.md,
> **this file wins**. CLAUDE.md's still-valid parts: frontend styling conventions (Tailwind
> semantic utilities, flat PostCSS, lucide-react, light theme default), the wizard flow, the
> Jira sync step-by-step, data transforms, and the auto-commit-after-build policy. Plan step
> 3.7 rewrites it properly.

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

## Where we are: Phase 0 ✅ G0 ✅ Phase 1 ✅ G1 ✅ Phase 2 ✅ G2 ✅ — **next is PHASE 3 (infra/launch)**

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
- Unit suites: backend `npm test` (**32** — +6 crypto envelope), frontend `npm test` (18), Flask
  `venv/Scripts/python.exe -m unittest discover -s tests` (**22**), bot same with `.venv` (**10**).
  ⚠️ The Flask/bot HTTP tests were silently red for a while: the internal-key gate reads
  `INTERNAL_API_KEY` at import and step 1.4 put that key in every service `.env`, so validation
  tests 401'd instead of 400'ing. They now send the key when it's configured (fixed 2026-07-16).
  **If a Python suite goes red with `401 != 400`, that's this — not your change.**
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

## Phase 2 ✅ (all 8 steps implemented, 2026-07-16) — per-org Jira & GitHub

Global `JIRA_*`/`GITHUB_TOKEN` are **gone** (zero reads in backend src). Each org connects its
own credentials, envelope-encrypted per org. The chain:

```
routes/{jira,sync,developers}.js → jiraClientFor(req.orgId) / githubClientFor(req.orgId)
  → credentialProvider (5-min TTL cache) → org_integrations (AES-256-GCM, cryptoService)
    → createJiraClient({domain,email,apiToken}) / createGithubClient(token)
```

- **412 is the not-connected contract**: `{success:false, error:'JIRA_NOT_CONNECTED'|'GITHUB_NOT_CONNECTED'}`,
  mapped in `utils/httpError.js` + the global error middleware. Frontend: `ApiError.notConnected`
  (`lib/api.js`) → `<NotConnected provider="..."/>` CTA. **Not-connected is a normal new-org state, never an error banner.**
- **Settings UI is NEW** (`pages/Settings.jsx` + `/settings` + sidebar "Configuration → Integrations").
  The plan said to repurpose `pages/jira/Settings.jsx` — it never existed. Tokens are write-only;
  admin-only writes (`requireOrgAdmin` → 403 `ORG_ADMIN_REQUIRED`).
- **Contract changes to know**: `getSprints` now REQUIRES boardId → `GET /api/jira/sprints` 400s
  without `?boardId` (the app uses `/jira/board/:boardId/sprints` via `useBoardSprints`; `useSprints`
  is dead code). Field-discovery cache is per-domain and **only caches successes** — caching a
  failure would let one org's 401 poison every org on that Jira domain (caught in adversarial review).
- `POST /api/db/developers/refresh` now refreshes **only the caller's org** (it used to sweep every
  org — with per-org tokens that would burn other tenants' GitHub rate limits). The daily cron still
  sweeps all orgs, skipping those without GitHub connected.
- Migration **005** = `org_integrations` (004 was `developers_email`).

## G2 ✅ PASSED (2026-07-16) — what's live right now

Org `org_3GXt…kPn` has Jira (`moix3838.atlassian.net`, 3 boards) + GitHub (`moizkhan38`, repo scope)
connected through the UI, both verified against the live APIs. **backend/.env no longer contains any
Jira/GitHub credential** — the app was restarted on the cleaned file and proven to run entirely from
the encrypted per-org store. The 0.1 GitHub-PAT follow-up is **CLOSED** (regenerated; old one 401s).
Synced project **TP1** exists in their Jira: scrum board 68, active sprint 36, 4 stories, points 4/4,
assignees 3/4.

**G2 residuals** (known, not blocking — pick up if convenient):
- non-admin → 403 never exercised (needs a 2nd member in the Clerk org; backend gate is unit-covered).
- The Jira invite-by-email path never fired: only `moizkhan38` has an email on the roster and he
  already has a Jira account. Devs without emails (`Saqibnawazkhan`, `Musak7`) can't be resolved →
  their stories sync unassigned. That's by design, and it's why TP1 has 1 unassigned story.
- Authed smoke connected-branch unrun (needs a 60s browser token: `await window.Clerk.session.getToken()`).

**Found during G2, pre-existing, worth cleaning in Phase 3/4:** the `assignments` table is **never
written** — its org-scoped API (1.6) has no caller; assignments actually persist inside
`projects.raw` JSONB. Nothing is lost, but the table + endpoints are dead weight. Also, Jira
auto-creates an empty dateless "<KEY> Sprint 1" with every new Scrum board — not ours, ignore it.

## NEXT: PHASE 3 — production infra & launch (3.1–3.7)

3.1 Dockerfiles + compose (prod parity) → 3.2 structured logging + request IDs (pino) → 3.3
`/api/ready` readiness probe → 3.4 CI (build + gitleaks secret scan) → **3.5 hosting decision D3
= USER-ACTION** (managed PaaS vs single VPS) + `DEPLOYMENT.md` → 3.6 deploy + prod smoke →
**3.7 rewrite `.claude/CLAUDE.md`** (it's gitignored, so local-only; already carries a correct
"Per-Org Integrations" section added in 2.8, but the auth/persistence/localStorage claims elsewhere
are still pre-migration). Gate G3 = launch.

Decisions locked: D1 encrypted tokens now/OAuth Phase 4 · D2 Clerk · D3 hosting deferred ·
D4 Postgres persistence · D5 platform Gemini key · D6 bot single-workspace v1.
