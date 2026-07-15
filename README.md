# Focus Flow — AI-Powered Scrum Master Automation Tool

Unified Scrum automation platform: AI-powered epic/story generation, developer analysis from GitHub commits, intelligent story-level assignment, Jira sprint monitoring with live kanban, and a Slack standup bot with blocker detection.

## Architecture

```
┌──────────────────────────────────┐
│  Frontend (React 19 + Vite)      │  Port 5173
└──────────────┬───────────────────┘
               │  HTTP + WebSocket
┌──────────────▼───────────────────┐
│  Backend (Express 5 + Socket.io) │  Port 3003
└──┬───────┬─────────┬─────────────┘
   │       │         │
┌──▼──┐ ┌──▼──┐ ┌────▼────────┐
│Flask│ │ PG  │ │Jira / GitHub│
│5000 │ │5432 │ │   APIs      │
└─────┘ └─────┘ └─────────────┘
```

| Service | Port | Stack |
|---|---|---|
| Frontend | 5173 | React 19 · Vite · Tailwind · framer-motion |
| Backend | 3003 | Express 5 · Socket.io · pg |
| AI Generator | 5000 | Flask · Google Gemini |
| Database | 5432 | PostgreSQL 18 |
| Standup Bot | 3000 | Flask · Slack Bolt · APScheduler |

## Features

- **Epic/story generation** — Gemini produces epics, user stories, acceptance criteria, and test cases from a plain-English project description
- **Developer analysis** — GitHub commit history → expertise detection + experience level
- **Story-level auto-assignment** — multi-factor scoring (expertise, experience, workload)
- **One-click Jira sync** — auto-creates project + board + team + sprints + all issues with assignees
- **Live kanban** — 2-way Jira sync via WebSockets; drag a card in one browser, everyone sees it instantly
- **Sprint dashboard** — burndown, burnup, velocity, blocker alerts, developer workload
- **Standup bot** — Slack slash command `/standup` with Gemini-powered blocker detection and auto Jira transitions
- **Stale-task alerts** — nudges Slack users about Jira tickets untouched for 24h
- **Report exports** — PDF / CSV / JSON per sprint

## Getting started

1. **Install prerequisites:** Node 20+, Python 3.11+, PostgreSQL 18
2. **Create database:** `CREATE DATABASE focusflow;`
3. **Copy the `.env.example` files** in each service folder and fill in your credentials
4. **Install deps:**
   ```
   cd epic-dev-assignment/backend && npm install
   cd epic-dev-assignment/frontend && npm install
   cd epic-generator && pip install -r requirements.txt
   cd standup-bot && pip install -r requirements.txt
   ```
5. **Run migrations:** `cd epic-dev-assignment/backend && npm run migrate`
6. **Start everything** (Windows): `cd epic-dev-assignment && start-all.bat`

## Project structure

```
integration/
├── epic-dev-assignment/
│   ├── backend/          Express + Socket.io + Postgres
│   └── frontend/         React SPA
├── epic-generator/       Flask Gemini wrapper
└── standup-bot/          Slack standup Flask app
```

## Production notes

This repo is being hardened for a multi-tenant SaaS deployment. The full plan, current status, and per-service env-var matrix live in [`PRODUCTION-PLAN.md`](PRODUCTION-PLAN.md).

Key operational requirements when deploying:

- **All config via env** — nothing hardcoded. Each service reads its own `.env` (see the `.env.example` files). `DATABASE_URL` is required (the backend refuses to start without it); set `DATABASE_SSL=true` for managed Postgres.
- **Internal services are gated** — set a shared `INTERNAL_API_KEY` across the backend, Flask, and standup bot so Flask and the bot only accept calls from the gateway. Set `SLACK_SIGNING_SECRET` for the bot (it refuses to start without it unless `FLASK_DEBUG=true`).
- **Run behind a real WSGI server** — Flask and the bot ship a `waitress-serve` command (printed in each app's startup banner); never run `FLASK_DEBUG=true` on a public host.
- **Frontend** — set `VITE_API_URL` at build time to point the static bundle at the backend origin (empty = same-origin behind a reverse proxy).
- **Behind a proxy/LB** — set `TRUST_PROXY=1` and `CORS_ORIGINS` to your real frontend origin.

## License

Private — all rights reserved.
