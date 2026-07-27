# Focus Flow — Deployment Runbook

**Hosting decision (D3): Managed PaaS.** Chosen 2026-07-16. Frontend on a static
host (Vercel/Netlify), the three backend services on a container PaaS
(Railway/Render) from the Dockerfiles in Phase 3.1, and managed Postgres
(Neon/Railway/Supabase). The single-VPS + Compose path is preserved in
[Appendix B](#appendix-b--single-vps--compose) in case you switch later — the
same Dockerfiles serve both.

> ⚠️ **Back up `CREDENTIALS_MASTER_KEY` before you deploy.** It decrypts every
> org's stored Jira/GitHub credentials. Lose it and every customer must
> reconnect their integrations. Store it in a password manager / secrets vault,
> not only in the platform env.

---

## 0. Architecture in production

```
Browser ── Clerk (prod instance) ──► Frontend (static, nginx/Vercel)
                                         │  /api, /socket.io  (VITE_API_URL)
                                         ▼
                                     Backend (Express :3003, PUBLIC)
                                      ├── Postgres (managed, SSL)
                                      ├── Flask epic-generator (INTERNAL only)
                                      └── Standup bot (PUBLIC for /slack/*, gated elsewhere)
Slack ──► Standup bot /slack/events (signature-verified)
```

Reachability:
- **Frontend, Backend** — public.
- **Flask** — internal only; only the backend calls it (gated by `INTERNAL_API_KEY`). Do **not** give it a public route.
- **Standup bot** — needs a public URL *for Slack webhooks only* (`/slack/*`, protected by Slack signature verification). `/api/standup*` stays gated by `INTERNAL_API_KEY`; `/test/*` by `ADMIN_API_KEY`.

---

## 1. Prerequisites

- Accounts: container PaaS (Railway or Render), static host (Vercel or Netlify), managed Postgres (Neon/Railway/Supabase), Clerk, Google AI (Gemini), Slack app (if using standups).
- A custom domain (optional but recommended): e.g. `app.yourdomain.com` (frontend), `api.yourdomain.com` (backend).
- The repo builds green in CI (`.github/workflows/ci.yml`).

### Generate the shared secrets first
```bash
# Shared internal-service key (identical value in backend + flask + bot):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Envelope master key (base64 32 bytes) — BACK THIS UP:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Admin key for the bot's /test/* routes (optional):
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## 2. Managed Postgres

1. Create a Postgres instance (Neon/Railway/Supabase).
2. Copy its connection string → `DATABASE_URL`.
3. Set **`DATABASE_SSL=true`** (managed providers use self-signed chains).
4. Migrations run automatically: the backend image's entrypoint runs
   `node scripts/migrate.js` before starting (idempotent via `schema_migrations`).
   To run manually once: `DATABASE_URL=… DATABASE_SSL=true npm run migrate` from `epic-dev-assignment/backend`.

---

## 3. Clerk — production instance

Clerk **dev** instances (`pk_test_`/`sk_test_`) are not for production. Create a
**production** instance:

1. Clerk dashboard → create/prod-ready instance → **Organizations** enabled, **membership required** (matches dev).
2. Add your frontend domain under **Allowed origins / Paths** (e.g. `https://app.yourdomain.com`).
3. Configure the production **Account Portal / domain** per Clerk's prod checklist (DNS records for the Frontend API).
4. Copy the production keys:
   - `pk_live_…` → frontend `VITE_CLERK_PUBLISHABLE_KEY` **and** backend `CLERK_PUBLISHABLE_KEY`
   - `sk_live_…` → backend `CLERK_SECRET_KEY`
5. Existing dev-instance orgs/users do **not** carry over — you (and customers) sign up fresh on prod.

---

## 4. Deploy the backend (container PaaS)

Deploy `epic-dev-assignment/backend` (its Dockerfile). Public service. Env:

| Var | Value |
|---|---|
| `PORT` | `3003` (or the platform's injected port) |
| `DATABASE_URL` | managed PG connection string |
| `DATABASE_SSL` | `true` |
| `FLASK_URL` | internal URL of the Flask service (e.g. `http://flask.internal:5000`) |
| `FOCUS_FLOW_URL` | internal/public URL of the bot service |
| `CORS_ORIGINS` | your frontend origin(s), comma-separated — e.g. `https://app.yourdomain.com` |
| `TRUST_PROXY` | `1` (behind the platform load balancer) |
| `JSON_BODY_LIMIT` | `2mb` (default) |
| `RATE_LIMIT_MAX` | `300` (default) |
| `INTERNAL_API_KEY` | the shared key from §1 |
| `DEV_REFRESH_CRON` | `0 3 * * *` (default) |
| `CLERK_SECRET_KEY` | `sk_live_…` |
| `CLERK_PUBLISHABLE_KEY` | `pk_live_…` |
| `CREDENTIALS_MASTER_KEY` | the base64 key from §1 (**backed up**) |
| `INTERNAL_ORG_ID` | **required** — the Clerk org id the standup bot serves (same as its `STANDUP_ORG_ID`). Unset ⇒ `/api/internal/*` is disabled (503). |
| `INTERNAL_CREDENTIALS_KEY` | a **second, distinct** key for `/api/internal/*`. Set it here and on the bot only — never on epic-generator. |
| `LOG_LEVEL` | `info` |

> `JIRA_*` and `GITHUB_TOKEN` are **gone** (Phase 2.8) — each org connects its own via the app's Integrations page.

Health probes: liveness `GET /api/health`, readiness `GET /api/ready` (point the platform's health check at `/api/ready`).

---

## 5. Deploy Flask (epic-generator) — internal

Deploy `epic-generator` (its Dockerfile). **Internal only.** Env:

| Var | Value |
|---|---|
| `GEMINI_API_KEY` | platform-owned Gemini key (enable billing before real load — D5) |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` (default) |
| `FLASK_DEBUG` | `false` |
| `HOST` | `0.0.0.0` |
| `PORT` | `5000` |
| `CORS_ORIGINS` | the backend's internal URL only |
| `INTERNAL_API_KEY` | **same** shared key as the backend |
| `LOG_LEVEL` | `INFO` |

---

## 6. Deploy the standup bot — public for Slack only

Deploy `standup-bot` (its Dockerfile). Public URL needed for `/slack/*`. Env:

| Var | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | from the Slack app (**required** in non-debug) |
| `GEMINI_API_KEY` | Gemini key |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` |
| `JIRA_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | bot's own Jira (single-workspace, D6) |
| `EXPRESS_DB_URL` | the backend's URL **including `/api/db/standups`** — a bare origin makes every standup fall back to an unencrypted on-disk JSON file |
| `INTERNAL_API_KEY` | **same** shared key |
| `INTERNAL_CREDENTIALS_KEY` | same value as the backend's — the key for fetching stored Slack/Jira credentials |
| `ADMIN_API_KEY` | from §1 (gates `/test/*`; unset → those routes 404) |
| `REMINDER_HOUR` / `REMINDER_MINUTE` | `9` / `30` (default daily reminder time) |
| `STANDUP_ORG_ID` | the Clerk **prod** org id this bot posts into |
| `STANDUP_DATA_FILE` | a persistent path (mount a volume) so local JSON survives redeploys |
| `LOG_LEVEL` | `INFO` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |

### Slack app URL updates (prod)
In the Slack app config, repoint every URL from your dev tunnel to the bot's prod URL:
- **Event Subscriptions** → Request URL → `https://<bot-prod-host>/slack/events`
- **Slash Commands** (`/standup`) → Request URL → `https://<bot-prod-host>/slack/command`
- **Interactivity** → Request URL → `https://<bot-prod-host>/slack/events`
Re-verify the URLs (Slack sends a challenge; signature verification must pass).

---

## 7. Deploy the frontend (static host)

Build `epic-dev-assignment/frontend`. `VITE_*` are baked in at **build** time and are all PUBLIC:

| Build arg / env | Value |
|---|---|
| `VITE_API_URL` | backend public URL — e.g. `https://api.yourdomain.com` |
| `VITE_SOCKET_URL` | same as `VITE_API_URL` (Socket.IO shares the origin) |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_…` |

- **SPA rewrites are required** so client-side routes resolve: on Vercel add a rewrite `/(.*) → /index.html`; on Netlify add `/* /index.html 200`. (The Docker/nginx path already does `try_files … /index.html`.)
- Because the frontend and backend are different origins here, `CORS_ORIGINS` on the backend (§4) **must** list the frontend origin, and `VITE_API_URL` must be the backend origin.

---

## 8. Post-deploy smoke checklist

Run against the **live** URLs:

- [ ] `GET https://<backend>/api/health` → 200; `GET /api/ready` → 200 `{db:true}`.
- [ ] Unauthenticated `GET https://<backend>/api/db/projects` → **401** (auth gate holds). Repeat for `/api/generate`, `/api/jira/sprints`, `/api/analyze-developers`, `DELETE /api/db/projects/x` — all 401.
- [ ] Frontend loads over HTTPS, **no mixed-content warnings** in the console.
- [ ] Sign up → create organization → wizard: generate epics → approve → analyze devs → assign → **Save (without Jira)** → project persists after refresh.
- [ ] Socket connects over **WSS** (devtools → Network → WS → 101).
- [ ] Integrations page: connect Jira + GitHub → status shows Connected, no token echoed in any response.
- [ ] Full **Sync to Jira** against a scratch Jira project → project/board/sprints/stories with points + assignees.
- [ ] A second org sees an empty workspace and gets 412s on Jira/GitHub until it connects its own (isolation).
- [ ] (If standups) `/standup` in Slack responds; the daily reminder job is scheduled once.
- [ ] Logs are JSON, carry request ids, and contain **no** token material.
- [ ] Lighthouse sanity pass on the frontend.

Record results + the live URL in the plan's Verification Log.

---

## Appendix A — Full env matrix

See [`PRODUCTION-PLAN.md` Appendix A](PRODUCTION-PLAN.md#appendix-a--environment-variable-matrix) for the authoritative table (every variable, which phase introduced it, defaults). The per-service tables in §4–§7 above mirror it for the deploy.

---

## Appendix C — Railway quick-deploy (fastest backend path)

Frontend stays on Vercel (already live). This deploys the backend half. Minimum
for **AI epic generation** to work end to end: Postgres + backend (Express) +
Flask. The bot is optional (Slack standups only).

### Pre-req: generate two production secrets (don't reuse the local ones)
The cloud DB is empty, so a fresh master key is correct (and keeps the local key local):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # CREDENTIALS_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # INTERNAL_API_KEY (same value in backend + flask)
```
Also: **enable Gemini billing** on the key's Google Cloud project, or generation 429s.

### Stage 1 — Postgres
1. railway.app → sign in with GitHub → **New Project**.
2. **+ New → Database → PostgreSQL**. Railway provisions it and exposes `DATABASE_URL` as a reference variable.

### Stage 2 — Backend (Express), public
1. In the same project: **+ New → GitHub Repo** → pick the Focus-Flow repo.
2. Service **Settings → Source → Root Directory** = `epic-dev-assignment/backend`. Railway detects the Dockerfile.
3. Service **Settings → Networking → Generate Domain** → gives a public URL like `focusflow-backend-production.up.railway.app`.
4. **Variables** (Settings → Variables):
   | Var | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the PG service) |
   | `DATABASE_SSL` | `false` (Railway private network); `true` if you use the public PG URL |
   | `CLERK_SECRET_KEY` | `sk_test_…` (the SAME Clerk instance as the frontend's `pk_test`) |
   | `CLERK_PUBLISHABLE_KEY` | `pk_test_…` |
   | `CREDENTIALS_MASTER_KEY` | the base64 key you generated |
   | `INTERNAL_API_KEY` | the hex key you generated |
   | `CORS_ORIGINS` | `https://focusflowpk.com,https://www.focusflowpk.com` |
   | `FLASK_URL` | `http://${{flask.RAILWAY_PRIVATE_DOMAIN}}:${{flask.PORT}}` (fill after Stage 3) |
   | `TRUST_PROXY` | `1` |
   | `NODE_ENV` | `production` |
   | `LOG_LEVEL` | `info` |
5. The entrypoint runs migrations automatically on first boot. Check **Deploy logs** for `[entrypoint] running migrations…` then `backend listening`.
6. Verify: `https://<backend-domain>/api/health` → 200, `/api/ready` → `{db:true}`.

### Stage 3 — Flask (epic-generator), private
1. **+ New → GitHub Repo** → same repo → **Root Directory** = `epic-generator`.
2. Do **NOT** generate a public domain (internal only). Railway gives it a private domain automatically.
3. **Variables**:
   | Var | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Gemini key (billing enabled) |
   | `GEMINI_MODEL` | `gemini-flash-lite-latest` |
   | `INTERNAL_API_KEY` | **same** value as the backend |
   | `FLASK_DEBUG` | `false` |
4. Back on the **backend** service, set `FLASK_URL` = `http://${{flask.RAILWAY_PRIVATE_DOMAIN}}:${{flask.PORT}}` (Railway reference vars; `flask` = the Flask service's name). Redeploy the backend so it picks this up.

### Stage 4 — Point the frontend at the backend
1. Vercel → project → **Settings → Environment Variables**:
   - `VITE_API_URL` = `https://<backend-domain>` (Stage 2 domain, no trailing slash)
   - `VITE_SOCKET_URL` = same value
2. **Redeploy** the Vercel frontend (env vars bake in at build time).

### Verify end to end
- focusflowpk.com → sign in → **New Project** → generate epics → should return epics (not "Load failed").
- If it 429s: Gemini billing isn't enabled yet.
- If CORS error in console: `CORS_ORIGINS` on the backend must list your exact frontend origin.

---

## Appendix B — Single VPS + Compose (alternative to the chosen PaaS path)

Kept for completeness; the same Dockerfiles serve it.

1. Provision a VPS (Ubuntu), install Docker + Compose.
2. `git clone` the repo; create each service's `.env` (from its `.env.example`) plus the **root `.env`** (`.env.example` at repo root) for the compose interpolation vars: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `FRONTEND_PORT`, `BACKEND_PORT`, `VITE_API_URL` (empty = same-origin), `VITE_SOCKET_URL`, `VITE_CLERK_PUBLISHABLE_KEY`.
3. `docker compose -f docker-compose.prod.yml up --build -d` — postgres → migrate → backend/flask/bot → frontend. Only frontend + backend publish ports.
4. Put **Caddy or nginx** in front for TLS. One origin (frontend serves `/api` + `/socket.io` to the backend via nginx), so **no CORS** to configure and `VITE_API_URL` stays empty (same-origin). Route `/slack/*` to the bot.
5. Backups: a `pg_dump` cron against the `pgdata` volume (managed PG in the PaaS path does this for you).
6. Same Clerk-prod / Slack-URL / smoke steps as §3, §6, §8.
