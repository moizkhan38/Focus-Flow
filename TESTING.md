# Focus Flow — Testing & Regression Harness

Baseline established **2026-07-14**: 74 unit tests + 27-check smoke harness, all green against the current (pre-migration) behavior. This harness is the safety net for the PRODUCTION-PLAN.md migration — the Verifier (Fable) re-runs it at every phase gate.

## The contract-evolution rule

A failing test is either a **regression** (fix the code) or a **deliberate contract change** (a plan step changed behavior on purpose — e.g. Phase 1 turns open 200s into 401s). For deliberate changes, update the affected tests/checks **in the same commit** as the change and note it in the plan's Execution Log. Never leave the harness red between steps.

## Unit suites (74 tests, no network, no services needed)

| Suite | Run (from repo root) | Pins down |
|---|---|---|
| Backend — 26 | `cd epic-dev-assignment/backend && npm test` | story-level assignment scoring/rebalancing/reassign, keyword epic classifier (+ Gemini-unreachable fallback), expertise detection, experience levels |
| Frontend — 18 | `cd epic-dev-assignment/frontend && npm test` | description validator (30/4000/5 contract, placeholders, gibberish), epic-count estimation, quality hints, sprint health score (40/30/20/10 weights) |
| Flask — 21 | `cd epic-generator && venv/Scripts/python.exe -m unittest discover -s tests` | `check_description` (mirrors JS validators), `_strip_markdown`, `parse_multiple_epics` (epics/stories/points/AC/test-cases from raw LLM text), HTTP validation 400s via test client |
| Standup bot — 9 | `cd standup-bot && .venv/Scripts/python.exe -m unittest discover -s tests` | ticket-extraction regex safety net (`final 3` → `FINAL-3`), Gemini/regex merge dedup, quantity false-positive guard, blocker ticket flow, bad-JSON failure path — Gemini/Slack/Jira fully mocked |

Notes:
- Node suites use the built-in `node:test` runner — zero new dependencies.
- Bot tests set dummy env + patch `BackgroundScheduler.start` **before** importing `app` (the module starts its scheduler at import; the 2-min reminder must never run in tests).
- Bot venv: `standup-bot/.venv` (created 2026-07-14, Python 3.14, from `requirements.txt`).
- Classifier tests point `FLASK_URL` at a dead port so the Gemini tie-break path deterministically falls back — hermetic and free.

## Smoke harness (live stack over HTTP)

```
node smoke-test.mjs                  # 26 checks, safe, ~5s
node smoke-test.mjs --ai             # + one real Gemini generation (~30–60s, costs quota)
node smoke-test.mjs --strict-external  # external-dep warnings become failures
```

Env overrides: `API_BASE`, `FLASK_BASE`, `BOT_BASE`, `FRONTEND_BASE` (defaults: localhost 3003/5000/3000/5173).

**Safety guarantees** (why it's always safe to run):
- Never sends a valid payload to `POST /api/ai/sync-jira` — only the `<2 approved epics` path, which 400s **before** any Jira call. No Jira projects, no email invites.
- Never touches the bot's `/test/*` routes (mass Slack DMs).
- Jira checks are read-only GETs; bot history check filters by a nonexistent project key (no Slack enrichment calls).
- DB roundtrip creates and deletes only its own `smoke-e2e-test` row.
- Real AI generation only with `--ai`.
- When starting the bot just for smoke, override the token: `SLACK_BOT_TOKEN='xoxb-smoke-invalid' .venv/Scripts/python.exe app.py` — double-safety against the (known, Step 0.4) 2-minute reminder bug DMing real users.

**Result classes**: `FAIL` = our contract broke (exit 1). `WARN` = external dependency issue (Jira creds/board, optional service down). `SKIP` = service not running / flag not passed.

**Known WARN** (pre-existing, not a regression): `GET /api/jira/sprints` → 500 `Jira API error: 400` when `JIRA_BOARD_ID` is unset in `backend/.env`.

## Baseline results (2026-07-14)

- Unit: backend 26/26 · frontend 18/18 · flask 21/21 · bot 9/9
- Smoke `--ai`: **25 PASS · 0 FAIL** · 1 WARN (unset board id) · 1 SKIP (vite dev not running)
- AI pipeline verified end-to-end: 3 epics / 6 stories generated through Express→Flask→Gemini→parser
- `npm run build` (frontend): clean

## Found & fixed while establishing the baseline

- `epic-generator/requirements.txt` was missing `python-dotenv` (imported by `web_app.py:9`) — a fresh `pip install -r requirements.txt` produced a service that couldn't boot. Added.
- Repo `standup-bot/` had no working Python env (root `.venv` points at a removed interpreter; the `Documents/standup-bot` copy's venv lacks `google-genai`). Created `standup-bot/.venv` from `requirements.txt`.
