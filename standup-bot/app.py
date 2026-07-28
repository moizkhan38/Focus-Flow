import os
import re
import json
import logging
import hmac
import socket
import ipaddress
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
from zoneinfo import ZoneInfo
import requests
from datetime import datetime, date
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from slack_sdk import WebClient
from slack_sdk.signature import SignatureVerifier
from atlassian import Jira
from google import genai
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

load_dotenv()

# Structured, level-controlled logging (Phase 3, step 3.2). LOG_LEVEL env
# (default INFO) also governs Flask/Werkzeug + APScheduler logs. Timestamps included.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("standup-bot")

# Resolve the data file relative to this script, not the process CWD.
# STANDUP_DATA_FILE overrides the location so a container can point it at a
# mounted volume (otherwise the file — and any standups not yet flushed to
# Postgres — vanishes on every redeploy).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STANDUP_JSON_PATH = os.environ.get("STANDUP_DATA_FILE") or os.path.join(BASE_DIR, "standup_data.json")

# --- Security / runtime config ---
SLACK_SIGNING_SECRET = os.environ.get("SLACK_SIGNING_SECRET", "")
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")   # gates /api/standup* (Express → bot)
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")         # gates /test/* (hidden unless set)
FLASK_DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
REMINDER_HOUR = int(os.environ.get("REMINDER_HOUR", "9"))
REMINDER_MINUTE = int(os.environ.get("REMINDER_MINUTE", "30"))
# The wall clock the reminder time is expressed in. Without this the cron ran in
# the HOST's local timezone, which is UTC on every container platform — so a
# 09:30 reminder reached a UTC+5 team at 14:30 and looked like it was firing at
# the wrong time. The bot serves one workspace (D6), so one timezone is correct.
REMINDER_TIMEZONE = os.environ.get("REMINDER_TIMEZONE", "Asia/Karachi")
# 0 / unset = once daily at the time above. Any positive value switches the
# reminder to that interval instead — for demos and testing. See the scheduler.
REMINDER_INTERVAL_MINUTES = int(os.environ.get("REMINDER_INTERVAL_MINUTES", "0") or 0)

# Slack credentials may come from this process's env OR from the org's stored
# Integrations credentials (resolved at request time by _slack_config below), so
# a missing env secret is no longer fatal at startup — the admin may simply not
# have pasted them yet. The guarantee that matters is preserved in the request
# gate: without a signing secret, Slack requests are REFUSED, never accepted
# unverified.
if not SLACK_SIGNING_SECRET and not FLASK_DEBUG:
    log.warning(
        "SLACK_SIGNING_SECRET is not set in the environment. Starting anyway — Slack "
        "requests will be refused with 503 until credentials are saved in the "
        "Integrations page (or the env var is set)."
    )

app = Flask(__name__)


@app.before_request
def _gate_requests():
    path = request.path
    # Slack endpoints: prove the request genuinely came from Slack.
    if path.startswith("/slack/"):
        verifier = get_signature_verifier()
        if verifier is None:
            if FLASK_DEBUG:
                return None  # dev only
            # No signing secret from env or Integrations — refuse rather than
            # accept forgeable requests.
            return jsonify({"error": "Slack is not configured for this deployment"}), 503
        if not verifier.is_valid_request(request.get_data(), dict(request.headers)):
            return jsonify({"error": "invalid Slack signature"}), 401
        return None
    # Internal server-to-server endpoints (Express → bot).
    if path == "/api/standup" or path.startswith("/api/standup/"):
        # FAIL CLOSED. This used to be `if INTERNAL_API_KEY and ...`, which meant
        # an unset key disabled the check entirely — on the one service that must
        # be reachable from the internet for Slack. A missing key is now a refusal
        # in production, and only tolerated when FLASK_DEBUG is on.
        if not INTERNAL_API_KEY:
            if FLASK_DEBUG:
                return None
            return jsonify({"error": "internal key not configured"}), 503
        if not hmac.compare_digest(
            request.headers.get("X-Internal-Key", ""), INTERNAL_API_KEY
        ):
            return jsonify({"error": "unauthorized"}), 401
        return None
    # Test/admin endpoints: hidden (404) unless an admin key is set AND matches.
    if path.startswith("/test/"):
        if not ADMIN_API_KEY or not hmac.compare_digest(
            request.headers.get("X-Admin-Key", ""), ADMIN_API_KEY
        ):
            return jsonify({"error": "not found"}), 404
        return None
    # Health probe stays open — no dependencies, no data.
    if path == "/api/health":
        return None

    # DEFAULT CLOSED. Anything not matched above is refused rather than served.
    # This service is internet-facing, and the previous `return None` fallthrough
    # meant any route not explicitly listed — /analyze/standup, and any route
    # added later — was reachable by anyone with the URL.
    return jsonify({"error": "not found"}), 404


# ─── Slack credential resolution ─────────────────────────────────────────────
# Credentials come from the org's Integrations page when present, falling back to
# this process's env vars. Resolved lazily per request (cached) rather than at
# import, so pasting them in the UI takes effect without a restart.
#
# D6 still holds: ONE deployment serves ONE workspace, bound to ONE org via
# STANDUP_ORG_ID. This changes only *where the credentials live*, not how many
# workspaces the bot can serve.

SLACK_CFG_TTL_SECONDS = 60  # paste in the UI → live within a minute
_slack_cfg_cache = {"data": None, "fetched_at": 0}


def _express_base():
    """Origin of the Express API, tolerating either the full /api/db/standups
    URL or a bare origin in EXPRESS_DB_URL."""
    raw = os.environ.get("EXPRESS_BASE_URL") or EXPRESS_DB_URL or ""
    return raw.split("/api/")[0].rstrip("/")


def _slack_config(force=False):
    """Current Slack config: stored org credentials if available, else env.

    Cached for SLACK_CFG_TTL_SECONDS because slash commands must answer inside
    Slack's 3-second deadline and this can make a network call.
    """
    import time
    now = time.time()
    cached = _slack_cfg_cache["data"]
    if not force and cached and now - _slack_cfg_cache["fetched_at"] < SLACK_CFG_TTL_SECONDS:
        return cached

    cfg = {
        "botToken": os.environ.get("SLACK_BOT_TOKEN", ""),
        "signingSecret": SLACK_SIGNING_SECRET,
        "analyzerUrl": os.environ.get("STANDUP_ANALYZER_URL", ""),
        "teamName": None,
        "source": "env",
    }

    base = _express_base()
    if base and STANDUP_ORG_ID:
        try:
            r = requests.get(
                f"{base}/api/internal/slack-config", timeout=3, headers=_express_headers(credentials=True)
            )
            if r.ok:
                data = r.json()
                # Only take over if BOTH secrets are present — a half-filled
                # record must not silently disable request verification.
                if data.get("botToken") and data.get("signingSecret"):
                    cfg = {
                        "botToken": data["botToken"],
                        "signingSecret": data["signingSecret"],
                        "analyzerUrl": data.get("analyzerUrl") or "",
                        "teamName": data.get("teamName"),
                        "source": "integrations",
                    }
                    _slack_cfg_cache["adopted"] = True
            elif r.status_code == 404:
                # Not connected. If this bot has EVER run on Integrations-sourced
                # credentials, a 404 now means the admin pressed Disconnect —
                # revocation, not "never configured". Falling back to the env
                # token here is what made the UI lie: Settings reported the
                # credential removed while the bot kept accepting Slack requests
                # and driving Jira with the token still sitting in its .env.
                if _slack_cfg_cache.get("adopted"):
                    log.warning("Slack integration was disconnected — refusing to fall back to env")
                    cfg = {
                        "botToken": "", "signingSecret": "", "analyzerUrl": "",
                        "teamName": None, "source": "revoked",
                    }
            else:
                log.warning(f"slack-config returned {r.status_code}")
                if _slack_cfg_cache.get("adopted") and cached:
                    # Transient backend failure: keep serving the last
                    # Integrations-sourced config rather than silently
                    # downgrading to env, which anyone able to break the
                    # bot->backend hop could otherwise force.
                    return cached
        except Exception as e:
            log.warning(f"slack-config fetch failed: {e}")
            if _slack_cfg_cache.get("adopted") and cached:
                return cached

    _slack_cfg_cache["data"] = cfg
    _slack_cfg_cache["fetched_at"] = now
    return cfg


_slack_client_cache = {"token": None, "client": None}


def get_slack_client():
    """WebClient for the currently-configured bot token, rebuilt when it changes."""
    token = _slack_config().get("botToken") or ""
    if _slack_client_cache["client"] is None or _slack_client_cache["token"] != token:
        _slack_client_cache["token"] = token
        _slack_client_cache["client"] = WebClient(token=token)
    return _slack_client_cache["client"]


_verifier_cache = {"secret": None, "verifier": None}


def get_signature_verifier():
    """SignatureVerifier for the current signing secret, or None if unconfigured."""
    secret = _slack_config().get("signingSecret") or ""
    if not secret:
        return None
    if _verifier_cache["verifier"] is None or _verifier_cache["secret"] != secret:
        _verifier_cache["secret"] = secret
        _verifier_cache["verifier"] = SignatureVerifier(secret)
    return _verifier_cache["verifier"]


# Initialize Clients
gemini_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-flash-lite-latest')  # lite alias: free-tier quota + never 404-deprecates
# ─── Jira credential resolution ──────────────────────────────────────────────
# The organization's Jira credentials — the same ones connected in the app's
# Integrations page — take precedence over this process's env vars.
#
# This matters for correctness, not just tidiness: the app creates Jira projects
# using the ORG's credentials, so if the bot carried its own copy pointing at a
# different Atlassian site, newly created projects would never appear in the
# /standup project picker. Resolving from one source keeps them in step, and
# removes the last plaintext Jira token from disk.
#
# Deliberately does NOT read the Flask request context: the scheduler jobs
# (reminders, stale-ticket scans) call Jira outside any request.

JIRA_CFG_TTL_SECONDS = 300
_jira_cfg_cache = {"data": None, "fetched_at": 0}
_jira_client_cache = {"sig": None, "client": None}


def _jira_config(force=False):
    """Org-stored Jira credentials if available, else this process's env."""
    import time
    now = time.time()
    cached = _jira_cfg_cache["data"]
    if not force and cached and now - _jira_cfg_cache["fetched_at"] < JIRA_CFG_TTL_SECONDS:
        return cached

    cfg = {
        "url": (os.environ.get("JIRA_URL") or "").strip(),
        "email": (os.environ.get("JIRA_EMAIL") or "").strip(),
        "token": (os.environ.get("JIRA_API_TOKEN") or "").strip(),
        "source": "env",
    }

    base = _express_base()
    if base and STANDUP_ORG_ID:
        try:
            r = requests.get(
                f"{base}/api/internal/jira-config", timeout=5, headers=_express_headers(credentials=True)
            )
            if r.ok:
                d = r.json()
                # Take over only when the record is complete; a half-filled one
                # must not leave the client half-configured.
                if d.get("domain") and d.get("email") and d.get("apiToken"):
                    domain = str(d["domain"]).strip().rstrip("/")
                    if not domain.startswith("http"):
                        domain = f"https://{domain}"
                    cfg = {
                        "url": domain,
                        "email": d["email"],
                        "token": d["apiToken"],
                        "source": "integrations",
                    }
                    _jira_cfg_cache["adopted"] = True
            elif r.status_code == 404:
                # Same revocation semantics as _slack_config: once this bot has
                # run on org-supplied Jira credentials, a 404 means Disconnect.
                # Reverting to the env token would keep the bot writing to Jira
                # with a credential the admin believes they removed.
                if _jira_cfg_cache.get("adopted"):
                    log.warning("Jira integration was disconnected — refusing to fall back to env")
                    cfg = {"url": "", "email": "", "token": "", "source": "revoked"}
            else:
                log.warning(f"jira-config returned {r.status_code}")
                if _jira_cfg_cache.get("adopted") and cached:
                    return cached
        except Exception as e:
            log.warning(f"jira-config fetch failed: {e}")
            if _jira_cfg_cache.get("adopted") and cached:
                return cached

    _jira_cfg_cache["data"] = cfg
    _jira_cfg_cache["fetched_at"] = now
    return cfg


def get_jira_client():
    """Jira client for the currently-resolved credentials, rebuilt when they change."""
    cfg = _jira_config()
    sig = (cfg["url"], cfg["email"], cfg["token"])
    if _jira_client_cache["client"] is None or _jira_client_cache["sig"] != sig:
        _jira_client_cache["sig"] = sig
        _jira_client_cache["client"] = Jira(
            url=cfg["url"], username=cfg["email"], password=cfg["token"], cloud=True
        )
    return _jira_client_cache["client"]

# Bounded pool for background standup processing — prevents unbounded thread
# creation under rapid /standup submissions.
background_executor = ThreadPoolExecutor(max_workers=5, thread_name_prefix="standup-bg")

# Jira project cache. Slack slash commands must respond in <3s, so we can't
# call Jira inline. Cache the project list and refresh in the background.
_jira_projects_cache = {"options": [], "fetched_at": 0}
_jira_project_names = {}  # key -> friendly name, populated alongside the options cache
JIRA_PROJECTS_TTL_SECONDS = 300  # refresh every 5 minutes


def _build_default_project_options():
    default_key = os.environ.get("JIRA_PROJECT_KEY", "SCRUM")
    return [
        {
            "text": {"type": "plain_text", "text": default_key},
            "value": default_key,
        }
    ]


def refresh_jira_projects_cache():
    """Fetch Jira projects and update the cache. Safe to call from a background thread."""
    import time
    try:
        projects = get_jira_client().get("rest/api/3/project")
        options = [
            {
                "text": {"type": "plain_text", "text": f"{p['name']} ({p['key']})"},
                "value": p["key"],
            }
            for p in projects
        ] or _build_default_project_options()
        _jira_projects_cache["options"] = options
        _jira_projects_cache["fetched_at"] = time.time()
        _jira_project_names.clear()
        for p in projects:
            if p.get("key") and p.get("name"):
                _jira_project_names[p["key"]] = p["name"]
        log.info(f"[JIRA-CACHE] Refreshed {len(options)} project options")
    except Exception as e:
        log.info(f"[JIRA-CACHE] Refresh failed: {e}")
        if not _jira_projects_cache["options"]:
            _jira_projects_cache["options"] = _build_default_project_options()


def get_project_name(key):
    """Return the friendly Jira project name for a key, falling back to the key itself."""
    return _jira_project_names.get(key, key)


def _format_project(key):
    """Render a project as 'Name (KEY)' if a name is known, else just the key."""
    name = _jira_project_names.get(key)
    return f"{name} ({key})" if name and name != key else key


def get_cached_project_options():
    """Return cached project options, falling back to defaults if cache is empty."""
    import time
    if not _jira_projects_cache["options"]:
        return _build_default_project_options()
    # Trigger an async refresh if stale, but always return what we have now.
    if time.time() - _jira_projects_cache["fetched_at"] > JIRA_PROJECTS_TTL_SECONDS:
        background_executor.submit(refresh_jira_projects_cache)
    return _jira_projects_cache["options"]


PROJECT_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")

# Cap on how many tickets one standup may transition. A submission naming
# hundreds of IDs is either a mistake or an attempt to sweep a board.
MAX_TICKETS_PER_STANDUP = 20


def is_known_project(project_key):
    """True if this key is one the bot actually offers for standups."""
    key = str(project_key or "").upper()
    if not PROJECT_KEY_RE.match(key):
        return False
    known = {o.get("value", "").upper() for o in get_cached_project_options()}
    return key in known


def _scope_tickets(tickets, project_key):
    """Keep only well-formed ticket IDs belonging to `project_key`.

    Ticket IDs arrive from Gemini, whose input is the submitter's free-text
    standup — so they are attacker-influenceable, not a trusted extraction. This
    is the boundary that stops an injected instruction naming tickets in projects
    the standup was never filed against.
    """
    key = str(project_key or "").upper()
    if not PROJECT_KEY_RE.match(key):
        return []
    allowed = re.compile(rf"^{re.escape(key)}-\d+$")
    out, seen = [], set()
    for t in tickets or []:
        tid = str(t or "").upper().strip()
        if allowed.match(tid) and tid not in seen:
            seen.add(tid)
            out.append(tid)
        if len(out) >= MAX_TICKETS_PER_STANDUP:
            break
    return out


# --- Jira Actions ---


def verify_ticket_exists(ticket_id):
    """Check if a Jira ticket exists and user has access to it."""
    try:
        get_jira_client().issue(ticket_id)
        return True
    except Exception:
        return False


def get_ticket_assignee(ticket_id):
    """Get the assignee info of a Jira ticket. Returns (account_id, name)."""
    try:
        issue = get_jira_client().issue(ticket_id)
        assignee = issue["fields"].get("assignee")
        if assignee:
            return (
                assignee.get("accountId"),
                assignee.get("displayName", "Unknown"),
            )
        return None, None
    except Exception:
        return None, None


def get_jira_account_id(email):
    """Get the Jira account ID for an email address."""
    try:
        users = get_jira_client().user_find_by_user_string(query=email)
        if users:
            return users[0].get("accountId")
        return None
    except Exception:
        return None


# Slack user id -> Jira email (or accountId), for people whose Slack and Jira
# accounts use DIFFERENT addresses. JSON, e.g.
#   STANDUP_JIRA_USER_MAP={"U01ABC2DEF":"me@work.com","U05XYZ":"5f7a…accountId"}
# This is the explicit escape hatch: matching on email or name only works when
# the two systems agree, and often they don't.
def _load_user_map():
    raw = (os.environ.get("STANDUP_JIRA_USER_MAP") or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except Exception as e:
        log.warning("STANDUP_JIRA_USER_MAP is not valid JSON, ignoring it: %s", e)
        return {}


JIRA_USER_MAP = _load_user_map()


def resolve_submitter_jira_account(user_id):
    """Map the Slack user who submitted a standup to their Jira accountId.

    Returns (account_id, how) where `how` names the step that succeeded, or the
    reason nothing matched — the message shown to the user is only useful if it
    says WHICH lookup failed.

    Ordered strongest-first. Nothing here is allowed to fall back to the bot's own
    Atlassian identity: evaluating an unidentified submitter as the admin is what
    let any workspace member move any ticket.
    """
    # 1. Explicit mapping. Trusted outright — an operator configured it.
    mapped = JIRA_USER_MAP.get(user_id)
    if mapped:
        if "@" in mapped:
            acct = get_jira_account_id(mapped)
            if acct:
                return acct, "explicit map (email)"
            return None, f"STANDUP_JIRA_USER_MAP points at {mapped}, but Jira has no such user"
        return mapped, "explicit map (accountId)"

    # 2. Slack profile email — exact, and the same identity Jira knows when the
    #    two systems share an address.
    profile = {}
    try:
        profile = get_slack_client().users_info(user=user_id)["user"].get("profile", {}) or {}
    except Exception as e:
        return None, f"could not read your Slack profile ({e})"

    email = profile.get("email")
    if email:
        acct = get_jira_account_id(email)
        if acct:
            return acct, "Slack profile email"

    # 3. Display name, accepted ONLY when it resolves to exactly one Jira user.
    #    Weaker than an email match, so ambiguity is treated as no match rather
    #    than guessing which teammate you are.
    for field in ("real_name", "display_name"):
        name = (profile.get(field) or "").strip()
        if not name:
            continue
        try:
            matches = [u for u in get_jira_client().user_find_by_user_string(query=name)
                       if u.get("accountId") and u.get("active", True)]
        except Exception:
            matches = []
        if len(matches) == 1:
            return matches[0]["accountId"], f"Slack {field} matched one Jira user"
        if len(matches) > 1:
            return None, f'"{name}" matches {len(matches)} Jira users, so we cannot tell which is you'

    if email:
        return None, f"no Jira account uses {email}, and your Slack name matched none either"
    return None, "your Slack profile has no email address (the bot needs the users:read.email scope)"


def move_jira_ticket(ticket_id, status_name, user_account_id=None, identity_reason=None):
    """Transition a Jira ticket named in a standup.

    OWNERSHIP CHECK DISABLED (deliberate product decision).

    This previously refused unless the submitter's Jira account resolved AND the
    ticket was assigned to them. In practice that blocked most real standups: a
    Slack profile without an email, or a Slack and Jira account under different
    addresses, made the submitter unidentifiable, and the answer to "I finished
    SCRUM-3" became a denial.

    What is given up: a workspace member can move a ticket that is not theirs by
    naming it in their own standup. The remaining constraints still bound that —
    ticket IDs are restricted to the project the standup was filed against
    (_scope_tickets), capped at MAX_TICKETS_PER_STANDUP, the project must be one
    the bot offers, and Slack request signatures are verified — so this is scoped
    to members of the connected workspace acting on that workspace's own board.

    The equivalent rule on the web Kanban is UNCHANGED: transitions there remain
    assignee-only (middleware/jiraOwnership.js).
    """
    try:
        ticket_id = ticket_id.upper().strip()

        if not verify_ticket_exists(ticket_id):
            return (
                f"[SKIPPED] {ticket_id}: "
                "Issue does not exist or you don't have permission"
            )

        get_jira_client().issue_transition(ticket_id, status_name)
        return f"[SUCCESS] Moved {ticket_id} to {status_name}"
    except Exception as e:
        return f"[ERROR] Could not move {ticket_id}: {str(e)}"


def create_blocker_ticket(summary, description, project_key=None):
    """Create a high-priority blocker ticket in Jira."""
    try:
        if not project_key:
            project_key = os.environ.get("JIRA_PROJECT_KEY")
        issue_dict = {
            "project": {"key": project_key},
            "summary": f"BLOCKER: {summary}",
            "description": description,
            "issuetype": {"name": "Task"},
            "priority": {"name": "High"},
        }
        new_issue = get_jira_client().create_issue(fields=issue_dict)
        return f"[BLOCKER] Created Blocker Ticket: {new_issue['key']}"
    except Exception as e:
        return f"[ERROR] Failed to create blocker: {e}"


# --- Background Logic ---


EXPRESS_DB_URL = os.environ.get("EXPRESS_DB_URL", "http://localhost:3003/api/db/standups")
# Clerk org this bot's standups belong to (single-workspace deployment binding, D6).
STANDUP_ORG_ID = os.environ.get("STANDUP_ORG_ID", "")


# The lane that returns DECRYPTED credentials uses its own key when one is set.
# INTERNAL_API_KEY is shared with epic-generator, which holds it only to VERIFY
# inbound calls — but with one symmetric secret, holding the verifier is holding
# the caller credential, so a file read in that small Flask app was enough to pull
# plaintext tokens out of the backend. Set INTERNAL_CREDENTIALS_KEY here and on
# the backend (and nowhere else) to separate the two.
INTERNAL_CREDENTIALS_KEY = os.environ.get("INTERNAL_CREDENTIALS_KEY", "")


def _express_headers(credentials=False):
    """Auth headers for server-to-server calls into the Express API (1.4 lane).

    credentials=True selects the key for /api/internal/* (plaintext credentials).
    """
    headers = {}
    key = (INTERNAL_CREDENTIALS_KEY if credentials and INTERNAL_CREDENTIALS_KEY
           else INTERNAL_API_KEY)
    if key:
        headers["X-Internal-Key"] = key
    if STANDUP_ORG_ID:
        headers["X-Org-Id"] = STANDUP_ORG_ID
    return headers


def save_standup_to_json(user_id, project_key, yesterday, today, blocker, analysis,
                         user_name=None):
    """Save standup to Postgres via Express backend; fall back to JSON on failure.

    Returns (entry, destination) where destination is "db", "json" or None. The
    caller reports the destination back to Slack: a fallback to JSON means the
    standup will NEVER appear on the dashboard, and saying "saved" regardless is
    how a misconfigured EXPRESS_DB_URL stayed invisible for 25 standups.
    """
    full_text = f"Yesterday: {yesterday}. Today: {today}. Blockers: {blocker}"
    blocker_details = None
    if analysis.get("is_blocker"):
        blocker_details = {
            "type": analysis.get("blocker_type", "Unknown"),
            "impact": analysis.get("impact", "Unknown"),
            "recommendation": analysis.get("blocker_summary", ""),
        }

    new_entry = {
        "user_id": user_id,
        "user_name": user_name,
        "project_key": project_key,
        "timestamp": datetime.now().isoformat(),
        "full_text": full_text,
        "yesterday": yesterday,
        "today": today,
        "blocker": blocker,
        "is_blocker": analysis.get("is_blocker", False),
        "blocker_details": blocker_details,
        "sentiment": analysis.get("sentiment", "Neutral"),
        "finished_tickets": analysis.get("finished_tickets", []),
        "today_tickets": analysis.get("today_tickets", []),
        "raw_analysis": analysis,
    }

    # Primary: write to Postgres via Express
    try:
        resp = requests.post(EXPRESS_DB_URL, json=new_entry, timeout=5, headers=_express_headers())
        if resp.ok:
            log.info(f"Saved standup to DB for {user_id}")
            return new_entry, "db"
        log.warning(
            f"DB save to {EXPRESS_DB_URL} returned {resp.status_code}: {resp.text[:200]}"
        )
    except Exception as e:
        log.warning(f"DB save to {EXPRESS_DB_URL} failed, falling back to JSON: {e}")

    # Fallback: append to local JSON so data isn't lost if Express/DB is down
    try:
        try:
            with open(STANDUP_JSON_PATH, "r") as f:
                standup_data = json.load(f)
        except FileNotFoundError:
            standup_data = []
        standup_data.append(new_entry)
        with open(STANDUP_JSON_PATH, "w") as f:
            json.dump(standup_data, f, indent=4)
        log.error(
            "[FALLBACK] Standup for %s written to %s instead of the database — it "
            "will NOT appear on the dashboard. Check EXPRESS_DB_URL (currently %s).",
            user_id, STANDUP_JSON_PATH, EXPRESS_DB_URL,
        )
        return new_entry, "json"
    except Exception as e:
        log.error(f"Failed to save standup anywhere: {e}")
        return None, None


def _analyzer_url_is_safe(url):
    """Re-check the org-supplied analyzer URL at the point of use.

    The backend validates this field on save (https only, no private/link-local
    hosts). That check alone is not sufficient here: the value is stored and
    replayed later, DNS can be repointed after it was approved, and the request
    is made from INSIDE the private service network — so the bot is exactly the
    proxy an SSRF wants. Resolve the host now and refuse if any address it maps
    to is internal.
    """
    try:
        parts = urlparse(url)
    except Exception:
        return False
    if parts.scheme != "https" or not parts.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return bool(infos)


def send_to_standup_analyzer(standup_entry):
    """Send standup data to analyzer endpoint."""
    try:
        # Stored Integrations value wins over the env var (same as the Slack creds).
        analyzer_url = _slack_config().get("analyzerUrl")
        if not analyzer_url:
            log.warning("Standup analyzer URL not configured")
            return

        if not _analyzer_url_is_safe(analyzer_url):
            log.error("Refusing to send standup: analyzer URL resolves to a disallowed address")
            return

        # allow_redirects defaulted to True, which threw away every check the
        # backend makes: an approved https host could answer 307 and send the
        # payload — and the bot's private-network position — anywhere, including
        # http://169.254.169.254/ for cloud metadata. 3xx is now a failure.
        response = requests.post(
            analyzer_url, json=standup_entry, timeout=3, allow_redirects=False
        )
        if response.status_code == 200:
            log.info("Sent standup data to analyzer")
        elif 300 <= response.status_code < 400:
            log.error(
                "Analyzer URL returned a redirect (%s) — not followed. "
                "Point the integration directly at the final endpoint.",
                response.status_code,
            )
        else:
            log.warning("Analyzer responded with status %s", response.status_code)
    except Exception as e:
        log.error(f"Failed to send to analyzer: {e}")


def process_standup_logic(user_id, project_key, yesterday, today, blocker):
    """Core standup processing: AI analysis, Jira updates, Slack report."""
    log.info("[BACKGROUND] Analyzing standup for %s (%s)", user_id, project_key)

    # project_key reaches here from a Slack modal selection OR from the body of
    # POST /api/standup, so it is caller-supplied either way. Everything below
    # runs with the org's Jira credentials, so pin it to a project the bot
    # actually offers before any of that happens.
    if not is_known_project(project_key):
        log.warning("[BACKGROUND] Rejected standup for unknown project %r", project_key)
        return

    full_text = (
        f"What have you done yesterday: {yesterday}. "
        f"What will you do today: {today}. "
        f"Have you faced any blockers: {blocker}"
    )
    prompt = f"""Analyze this standup. Respond ONLY with JSON.

    The active Jira project key is: {project_key}

    RULES for Jira IDs:
    - ALWAYS convert ticket IDs to UPPERCASE (e.g., 'scrum-1' becomes 'SCRUM-1').
    - ALWAYS ensure there is a dash between the letters and numbers.
    - Loose references like "{project_key.lower()} 3", "{project_key} 6", "{project_key.lower()}3", or just a bare number when the user is clearly talking about a ticket in the active project, MUST be normalized to "{project_key}-N" (e.g., "{project_key.lower()} 3" -> "{project_key}-3").
    - Be AGGRESSIVE about extraction: if the user mentions the project name (any case) followed by or attached to a number, treat it as a ticket reference. Examples to extract: "done {project_key.lower()} 3", "finished {project_key} 7", "working on {project_key.lower()}-12", "will do {project_key} 6 and {project_key} 9".
    - Do NOT extract numbers that are clearly counts/quantities and unrelated to the project (e.g., "spent 3 hours", "fixed 2 bugs in unrelated areas").
    - 'finished_tickets': Jira IDs mentioned in Yesterday's work.
    - 'today_tickets': Jira IDs mentioned in Today's work.

    JSON Structure:
    - "is_blocker": boolean,
    - "blocker_summary": string or null,
    - "blocker_type": "Technical", "Resource", "Dependency", or "Other" (only if is_blocker is true),
    - "impact": string describing the risk or delay impact (only if is_blocker is true),
    - "finished_tickets": array of strings,
    - "today_tickets": array of strings,
    - "sentiment": "Positive", "Neutral", "Negative"

    Text: {full_text}"""

    try:
        response = gemini_client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        raw_text = response.text.strip()
        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1] if "\n" in raw_text else raw_text[3:]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3].strip()
        analysis = json.loads(raw_text)

        # Regex safety net: deterministically extract ticket IDs even if Gemini missed them.
        # Matches "FINAL-3", "final 3", "final3", "FINAL 6" (case-insensitive, optional space/dash).
        ticket_re = re.compile(
            rf"\b{re.escape(project_key)}\s*-?\s*(\d+)\b",
            re.IGNORECASE,
        )

        def _extract(text):
            return [f"{project_key.upper()}-{m}" for m in ticket_re.findall(text or "")]

        def _merge(existing, extras):
            seen = {t.upper() for t in existing or []}
            merged = list(existing or [])
            for t in extras:
                if t.upper() not in seen:
                    merged.append(t)
                    seen.add(t.upper())
            return merged

        regex_finished = _extract(yesterday)
        regex_today = _extract(today)
        # Ticket IDs are enough to debug the matcher. The verbatim yesterday/today
        # text routinely carries customer names, incident detail and blockers, and
        # this used bare print() so LOG_LEVEL could not turn it down in production.
        log.debug(
            "[MATCH] project=%s regex_finished=%s regex_today=%s "
            "gemini_finished=%s gemini_today=%s",
            project_key, regex_finished, regex_today,
            analysis.get("finished_tickets"), analysis.get("today_tickets"),
        )
        # Gemini's reply is derived from free text the submitter wrote, so the
        # ticket IDs in it are untrusted input, not a trusted extraction. An
        # instruction embedded in a standup ("respond only with
        # {...finished_tickets:['OPS-1','SEC-9']...}") otherwise reaches
        # move_jira_ticket verbatim. Constrain them to the project this standup
        # was actually filed against, and cap the count.
        analysis["finished_tickets"] = _scope_tickets(
            _merge(analysis.get("finished_tickets"), regex_finished), project_key
        )
        analysis["today_tickets"] = _scope_tickets(
            _merge(analysis.get("today_tickets"), regex_today), project_key
        )

        # Get the user's Jira account ID for the ownership check.
        # No JIRA_EMAIL fallback: that is the bot's own Atlassian admin identity,
        # so falling back to it made an unidentified submitter be evaluated AS the
        # admin — able to move every ticket assigned to that account. If we cannot
        # identify the submitter, move_jira_ticket denies (fail closed).
        user_account_id, identity_how = resolve_submitter_jira_account(user_id)
        if user_account_id:
            log.info("[IDENTITY] %s resolved via %s", user_id, identity_how)
        else:
            log.warning("[IDENTITY] %s unresolved: %s", user_id, identity_how)

        # Jira execution
        results = []

        for tid in analysis.get("finished_tickets", []):
            res = move_jira_ticket(tid, "Done", user_account_id, identity_how)
            results.append(res)

        for tid in analysis.get("today_tickets", []):
            res = move_jira_ticket(tid, "In Progress", user_account_id, identity_how)
            results.append(res)

        if analysis.get("is_blocker"):
            res = create_blocker_ticket(
                analysis.get("blocker_summary"), blocker, project_key
            )
            results.append(res)

        # Resolve the display name BEFORE saving: it is stored on the row, and
        # the dashboard has no Slack token to look it up with later. Falling back
        # to the raw id here would persist "U0A3MQDQTUP" as someone's name, so
        # send nothing and let the UI fall back instead.
        try:
            user_name = get_slack_client().users_info(user=user_id)["user"]["real_name"]
        except Exception as e:
            log.warning("Could not resolve Slack display name for %s: %s", user_id, e)
            user_name = None

        # Save standup data
        standup_entry, saved_to = save_standup_to_json(
            user_id, project_key, yesterday, today, blocker, analysis,
            user_name=user_name,
        )

        # The Slack report below still needs something to address them by.
        user_name = user_name or user_id

        # Build detailed report
        jira_report = (
            "\n".join(results) if results else "- No Jira actions needed."
        )

        finished = ", ".join(
            analysis.get("finished_tickets", [])
        ) or "None"
        today_tickets = ", ".join(
            analysis.get("today_tickets", [])
        ) or "None"

        # Tell the truth about where the standup landed. "Saved" when it only
        # reached the local JSON file sends the submitter away happy while the
        # dashboard stays empty and nobody knows why.
        if saved_to == "db":
            save_note = "_Standup saved — it will appear on the dashboard._"
        elif saved_to == "json":
            save_note = (
                "[WARNING] *Not saved to the dashboard.* The database was unreachable, "
                "so this standup was written to the bot's local file only. "
                "Tell your admin to check the bot's `EXPRESS_DB_URL`."
            )
        else:
            save_note = "[WARNING] *This standup could not be saved anywhere.*"

        blocker_section = ""
        if analysis.get("is_blocker"):
            blocker_section = (
                "\n\n*Blocker Detected:*\n"
                f"- *Type:* {analysis.get('blocker_type', 'Unknown')}\n"
                f"- *Impact:* {analysis.get('impact', 'Unknown')}\n"
                f"- *Details:* {analysis.get('blocker_summary', 'N/A')}"
            )

        get_slack_client().chat_postMessage(
            channel=user_id,
            text=(
                f"*Standup Report -- {user_name}*\n"
                f"*Project:* {project_key}\n"
                f"----------------------------------------\n\n"
                f"*Yesterday:* {yesterday}\n"
                f"*Today:* {today}\n"
                f"*Blockers:* {blocker}\n\n"
                f"----------------------------------------\n"
                f"*AI Analysis*\n"
                f"- *Sentiment:* {analysis.get('sentiment')}\n"
                f"- *Finished Tickets:* {finished}\n"
                f"- *Today's Tickets:* {today_tickets}\n"
                f"{blocker_section}\n\n"
                f"*Jira Actions:*\n{jira_report}\n\n"
                f"{save_note}"
            ),
        )

        # Send to analyzer in background (non-critical)
        if standup_entry:
            background_executor.submit(send_to_standup_analyzer, standup_entry)

    except Exception as e:
        import traceback
        log.error(f"Logic Error: {type(e).__name__}: {e}")
        traceback.print_exc()
        get_slack_client().chat_postMessage(
            channel=user_id,
            text=f"[WARNING] Standup processing failed: {type(e).__name__}: {e}",
        )


# --- Standup Analyzer Endpoint ---


@app.route("/analyze/standup", methods=["POST"])
def analyze_standup():
    """Receive and analyze standup data."""
    try:
        data = request.get_json()
        print(f"[ANALYZER] Received standup data from {data.get('user_id')}")
        print(f"  Sentiment: {data.get('sentiment')}")
        print(f"  Blocker: {data.get('is_blocker')}")

        return jsonify({
            "status": "success",
            "message": "Standup data received and analyzed",
        }), 200
    except Exception as e:
        log.error(f"Analyzer Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# --- Slack Endpoints ---


@app.route("/slack/command", methods=["POST"])
def slash_command():
    """Handle the /standup slash command. Acknowledges Slack within milliseconds
    and opens the modal in a background thread to stay under Slack's 3s deadline."""
    trigger_id = request.form.get("trigger_id")
    if trigger_id:
        background_executor.submit(_open_standup_modal_async, trigger_id)
    return "", 200


def _build_standup_modal(project_options):
    return {
        "type": "modal",
        "callback_id": "st_sub",
        "title": {"type": "plain_text", "text": "Focus Flow"},
        "submit": {"type": "plain_text", "text": "Submit"},
        "blocks": [
            {
                "type": "input",
                "block_id": "p_b",
                "element": {
                    "type": "static_select",
                    "action_id": "p_i",
                    "placeholder": {"type": "plain_text", "text": "Select a project"},
                    "options": project_options,
                },
                "label": {"type": "plain_text", "text": "Which project is this standup for?"},
            },
            {
                "type": "input",
                "block_id": "y_b",
                "element": {"type": "plain_text_input", "action_id": "y_i", "multiline": True},
                "label": {"type": "plain_text", "text": "What have you done yesterday?"},
            },
            {
                "type": "input",
                "block_id": "t_b",
                "element": {"type": "plain_text_input", "action_id": "t_i", "multiline": True},
                "label": {"type": "plain_text", "text": "What will you do today?"},
            },
            {
                "type": "input",
                "block_id": "b_b",
                "element": {"type": "plain_text_input", "action_id": "b_i", "multiline": True},
                "label": {"type": "plain_text", "text": "Have you faced any blockers?"},
                "optional": True,
            },
        ],
    }


def _open_standup_modal_async(trigger_id):
    """Open the standup modal in a background thread. trigger_id is valid for ~3s."""
    try:
        project_options = get_cached_project_options()
        modal = _build_standup_modal(project_options)
        get_slack_client().views_open(trigger_id=trigger_id, view=modal)
    except Exception as e:
        print(f"[STANDUP] Failed to open modal: {e}")


# Block Kit action_id for the "Submit Standup" button on reminder DMs.
SUBMIT_STANDUP_ACTION = "open_standup_modal"


def _build_reminder_blocks(headline, body):
    """Build a reminder DM with an inline 'Submit Standup' button.
    Clicking the button opens the same modal /standup opens — no command to remember."""
    return [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*{headline}*\n{body}"},
        },
        {
            "type": "actions",
            "block_id": "standup_reminder_actions",
            "elements": [
                {
                    "type": "button",
                    "action_id": SUBMIT_STANDUP_ACTION,
                    "style": "primary",
                    "text": {"type": "plain_text", "text": "📝 Submit Standup"},
                }
            ],
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": "Or type `/standup` if you prefer the command."}
            ],
        },
    ]


@app.route("/slack/events", methods=["POST"])
def interactions():
    """Handle Slack interactive events: modal submissions and button clicks."""
    raw_payload = request.form.get("payload")
    if not raw_payload:
        return jsonify({"error": "missing payload"}), 400
    try:
        payload = json.loads(raw_payload)
    except (ValueError, TypeError):
        return jsonify({"error": "invalid payload"}), 400
    payload_type = payload.get("type")

    # Modal submission — process the standup
    if payload_type == "view_submission":
        user_id = payload["user"]["id"]
        values = payload["view"]["state"]["values"]
        project_key = values["p_b"]["p_i"]["selected_option"]["value"]
        yesterday = values["y_b"]["y_i"]["value"]
        today = values["t_b"]["t_i"]["value"]
        blocker = values["b_b"]["b_i"]["value"] or "None"

        background_executor.submit(
            process_standup_logic, user_id, project_key, yesterday, today, blocker
        )
        return jsonify({"response_action": "clear"}), 200

    # Button click on a reminder DM — open the standup modal
    if payload_type == "block_actions":
        for action in payload.get("actions", []):
            if action.get("action_id") == SUBMIT_STANDUP_ACTION:
                trigger_id = payload.get("trigger_id")
                if trigger_id:
                    background_executor.submit(_open_standup_modal_async, trigger_id)
                break
        return "", 200

    return "", 200


@app.route('/api/standup', methods=['POST'])
def api_standup():
    """Accept a standup payload from the frontend and run analysis."""
    data = request.get_json(silent=True) or {}
    project_key = data.get('project_key') or os.environ.get('JIRA_PROJECT_KEY', 'SCRUM')
    yesterday = data.get('yesterday')
    today = data.get('today')
    blocker = data.get('blocker', 'None')
    user_id = data.get('user_id')

    if not yesterday or not today:
        return jsonify({
            'status': 'error',
            'error': 'Both yesterday and today fields are required.'
        }), 400

    try:
        background_executor.submit(
            process_standup_logic, user_id, project_key, yesterday, today, blocker
        )

        return jsonify({
            'status': 'processing',
            'message': 'Standup analysis started successfully.'
        }), 202
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e)}), 500


@app.route('/api/health', methods=['GET'])
def api_health():
    return jsonify({'status': 'running', 'service': 'Focus Flow Standup', 'port': 3000}), 200


# Workspace name is shown in the Integrations UI. auth.test needs no scope, but
# it is still a network call per request — cache it.
_workspace_cache = {"name": None, "fetched_at": 0}
WORKSPACE_TTL_SECONDS = 600


def _slack_workspace_name():
    import time
    now = time.time()
    if _workspace_cache["name"] and now - _workspace_cache["fetched_at"] < WORKSPACE_TTL_SECONDS:
        return _workspace_cache["name"]
    try:
        info = get_slack_client().auth_test()
        _workspace_cache["name"] = info.get("team")
        _workspace_cache["fetched_at"] = now
        return _workspace_cache["name"]
    except Exception as e:
        log.warning(f"Slack auth.test failed: {e}")
        return None


@app.route('/api/standup/status', methods=['GET'])
def api_standup_status():
    """Configuration snapshot for the Integrations UI.

    Reports which dependencies are configured and which Slack workspace / Clerk
    org this single-workspace deployment is bound to (D6). Booleans and names
    only — never token material. Behind the internal-key gate with the rest of
    /api/standup/*, so only Express can call it.
    """
    # force=True so the UI reflects a just-saved credential immediately rather
    # than up to SLACK_CFG_TTL_SECONDS later.
    cfg = _slack_config(force=True)
    jira_cfg = _jira_config(force=True)
    slack_configured = bool(cfg.get("botToken"))
    return jsonify({
        'success': True,
        'orgId': STANDUP_ORG_ID or None,
        'workspace': _slack_workspace_name() if slack_configured else None,
        # Timezone included deliberately: "09:30" alone is ambiguous, and the
        # host's UTC clock is exactly what made the reminder look mistimed.
        'reminder': f"{REMINDER_HOUR:02d}:{REMINDER_MINUTE:02d} {REMINDER_TIMEZONE}",
        'jiraProjectKey': os.environ.get("JIRA_PROJECT_KEY") or None,
        # 'integrations' = pasted in the UI, 'env' = this process's .env
        'credentialSource': cfg.get("source"),
        # Which Atlassian site the bot lists projects from. If this disagrees
        # with the org's connected Jira, app-created projects never show up in
        # the /standup picker — so surface it rather than leaving it implicit.
        'jiraSource': jira_cfg.get("source"),
        'jiraSite': jira_cfg.get("url") or None,
        'configured': {
            'slack': slack_configured,
            'signingSecret': bool(cfg.get("signingSecret")),
            'analyzer': bool(cfg.get("analyzerUrl")),
            'gemini': bool(os.environ.get("GEMINI_API_KEY")),
            'jira': bool(jira_cfg.get("url") and jira_cfg.get("token")),
            'orgBinding': bool(STANDUP_ORG_ID),
        },
    }), 200


def _load_standups_from_db(project_key=None):
    """Read standups from Postgres via the Express backend. Returns None on failure."""
    try:
        url = EXPRESS_DB_URL  # GET on the same URL that POST writes to
        params = {"limit": 200}
        if project_key:
            params["project_key"] = project_key
        resp = requests.get(url, params=params, timeout=5, headers=_express_headers())
        if not resp.ok:
            print(f"[HISTORY] DB read returned {resp.status_code}")
            return None
        return resp.json()
    except Exception as e:
        print(f"[HISTORY] DB read failed, falling back to JSON: {e}")
        return None


def _load_standups_from_json(project_key=None):
    try:
        with open(STANDUP_JSON_PATH, "r") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = []
    if project_key:
        data = [s for s in data if s.get('project_key') == project_key]
    return data


@app.route('/api/standup/history', methods=['GET'])
def api_standup_history():
    """Return standup history. Reads from Postgres first (the primary write
    target), falling back to standup_data.json so older entries aren't lost."""
    project_key = request.args.get('project_key')

    # Primary source: Postgres (matches the write path priority).
    standup_data = _load_standups_from_db(project_key)
    if standup_data is None:
        standup_data = _load_standups_from_json(project_key)
        # JSON is stored oldest-first; sort to match DB (newest-first).
        standup_data.sort(key=lambda s: s.get('timestamp') or '', reverse=True)

    # Enrich with Slack display names where possible
    for entry in standup_data:
        if entry.get('user_id') and not entry.get('user_name'):
            try:
                info = get_slack_client().users_info(user=entry['user_id'])
                entry['user_name'] = info['user']['real_name']
                entry['avatar'] = info['user']['profile'].get('image_72', '')
            except Exception:
                entry['user_name'] = entry['user_id']
                entry['avatar'] = ''

    return jsonify({'success': True, 'standups': standup_data})


# --- Proactive Blocker Scanner ---


def check_for_proactive_blockers():
    """Scan Jira for stale and pending tasks across all projects."""
    print("[SCAN] Checking for stale and pending tasks...")

    # Fetch all projects dynamically
    try:
        projects = get_jira_client().get("rest/api/3/project")
        project_keys = [p["key"] for p in projects]
    except Exception:
        project_keys = [os.environ.get("JIRA_PROJECT_KEY", "SCRUM")]

    for project_key in project_keys:
        checks = [
            {
                "jql": (
                    'status = "In Progress" AND updated < -1d'
                    f' AND project = "{project_key}"'
                ),
                "message": (
                    "*Stale Task Alert:* [{project}] Ticket *{key}* "
                    "({summary}) is In Progress but hasn't been "
                    "updated in over 24 hours. Are you blocked? "
                    "Type `/standup` if you need help!"
                ),
            },
            {
                "jql": (
                    'status = "To Do" AND assignee IS NOT EMPTY'
                    f' AND project = "{project_key}"'
                ),
                "message": (
                    "*Pending Task Reminder:* [{project}] Ticket "
                    "*{key}* ({summary}) is assigned to you and "
                    "still in To Do. Please start working on it "
                    "or update its status."
                ),
            },
        ]

        for check in checks:
            try:
                issues = get_jira_client().jql(check["jql"])["issues"]
                print(f"[SCAN] {project_key}: Found {len(issues)} issues for JQL: {check['jql']}")

                for issue in issues:
                    key = issue["key"]
                    assignee = issue["fields"].get("assignee")
                    if not assignee:
                        print(f"[SCAN] {key}: No assignee, skipping")
                        continue
                    assignee_email = assignee.get("emailAddress")
                    if not assignee_email:
                        print(f"[SCAN] {key}: Assignee has no email (privacy settings), skipping")
                        continue
                    summary = issue["fields"]["summary"]
                    status = issue["fields"]["status"]["name"]

                    try:
                        user_info = get_slack_client().users_lookupByEmail(
                            email=assignee_email
                        )
                        user_id = user_info["user"]["id"]

                        nudge_text = check["message"].format(
                            key=key,
                            summary=summary,
                            status=status,
                            project=project_key,
                        )
                        get_slack_client().chat_postMessage(
                            channel=user_id, text=nudge_text
                        )
                        print(
                            f"[SUCCESS] Nudged {assignee_email} "
                            f"regarding {key} ({status})"
                        )
                    except Exception as e:
                        print(
                            f"[WARNING] Could not notify Slack user "
                            f"{assignee_email} for {key}: {e}"
                        )

            except Exception as e:
                log.error(f"Scan Error for {project_key}: {e}")


# --- Standup Reminders ---


def get_all_slack_members():
    """Get all real (non-bot, non-deleted) Slack workspace members."""
    members = []
    try:
        result = get_slack_client().users_list()
        for member in result["members"]:
            if (
                not member.get("is_bot")
                and not member.get("deleted")
                and member.get("id") != "USLACKBOT"
            ):
                members.append({
                    "id": member["id"],
                    "name": member["profile"].get("real_name", "Unknown"),
                    "email": (member["profile"].get("email") or "").lower(),
                })
    except Exception as e:
        log.error(f"Failed to fetch Slack members: {e}")
    return members


# Tracks who has already received their first reminder today: {date_str: set(user_ids)}.
# First ping = combined digest; any later ping in the same day = one DM per pending project.
_reminded_today = {}


def _users_submitted_today():
    """Return the set of (user_id, project_key) tuples that submitted a standup today."""
    today_str = date.today().isoformat()
    db_data = _load_standups_from_db()
    standup_data = db_data if db_data is not None else _load_standups_from_json()
    return {
        (e.get("user_id"), e.get("project_key"))
        for e in standup_data
        if (e.get("timestamp") or "").startswith(today_str)
        and e.get("user_id")
        and e.get("project_key")
    }


def _get_user_projects_map(members):
    """Map each Slack user_id -> set of Jira project keys they have active assignments in.

    Active = issue is open (statusCategory != Done) AND assignee is set.
    Builds the map by querying Jira once per cached project and grouping by assignee email.
    """
    # These ran on the daily reminder schedule and printed the tenant's entire
    # employee email roster into the log stream — a much broader audience than
    # the Slack workspace itself. Counts are enough to debug the matcher; the
    # addresses themselves are logged only at DEBUG, which is off by default.
    email_to_uid = {m["email"].lower(): m["id"] for m in members if m.get("email")}
    members_without_email = [m["name"] for m in members if not m.get("email")]
    log.info(
        "[REMINDER] %d Slack member(s) with an email, %d without",
        len(email_to_uid), len(members_without_email),
    )

    # Reminders are matched by email, and Slack and Jira accounts frequently use
    # DIFFERENT addresses — which produced zero matches, and therefore total
    # silence, with nothing in the logs suggesting why.
    #
    # STANDUP_JIRA_USER_MAP already maps a Slack user id to their Jira email for
    # the standup flow. Invert it here so the same one-line configuration fixes
    # both. Entries pointing at an accountId rather than an email are skipped —
    # this lookup is keyed on the address Jira reports for an assignee.
    for slack_uid, jira_identity in JIRA_USER_MAP.items():
        if "@" in jira_identity:
            email_to_uid.setdefault(jira_identity.strip().lower(), slack_uid)
    if members_without_email:
        log.debug(
            "[REMINDER] members without email (check users:read.email scope): %s",
            members_without_email,
        )

    user_projects = {}
    seen_jira_emails = set()

    # Populate the project cache synchronously if it is still empty.
    #
    # get_cached_project_options() is built for the /standup request path, where
    # Slack's 3-second deadline means a cold cache must fall back to a SINGLE
    # default project and refresh in the background. That fallback is wrong here:
    # the reminder would query one project, match nobody, and send nothing —
    # which is exactly what happens on the first run after a deploy, silently.
    #
    # This is a scheduled job with no latency budget, so wait for the real list.
    if not _jira_projects_cache["options"]:
        log.info("[REMINDER] Project cache is cold — fetching the project list before matching")
        refresh_jira_projects_cache()

    project_options = get_cached_project_options()
    project_keys = [opt.get("value") for opt in project_options if opt.get("value")]
    log.info("[REMINDER] Checking %d project(s): %s", len(project_keys), ", ".join(project_keys))

    for key in project_keys:
        try:
            jql = (
                f'project = "{key}" AND statusCategory != Done '
                f'AND assignee IS NOT EMPTY'
            )
            result = get_jira_client().jql(jql, fields="assignee", limit=1000)
            for issue in result.get("issues", []):
                assignee = issue.get("fields", {}).get("assignee") or {}
                email = (assignee.get("emailAddress") or "").lower()
                if not email:
                    continue
                seen_jira_emails.add(email)
                uid = email_to_uid.get(email)
                if not uid:
                    continue
                user_projects.setdefault(uid, set()).add(key)
        except Exception as e:
            log.info(f"[REMINDER] Could not fetch assignees for {key}: {e}")

    unmatched = seen_jira_emails - set(email_to_uid.keys())
    if unmatched:
        log.info("[REMINDER] %d Jira assignee email(s) matched no Slack user", len(unmatched))
        log.debug("[REMINDER] unmatched Jira assignee emails: %s", sorted(unmatched))

    # Assignees exist but NONE of them map to a Slack account: the reminder is
    # about to send nothing at all, and the reason is a configuration mismatch
    # rather than an empty board. Say so plainly — silence here is what made this
    # hard to diagnose.
    if seen_jira_emails and not user_projects:
        log.warning(
            "[REMINDER] Found %d Jira assignee email(s) but matched NONE to a Slack "
            "member, so no reminders will be sent. The two systems are using "
            "different addresses. Map them with STANDUP_JIRA_USER_MAP, e.g. "
            '{"U01ABC2DEF":"person@jira-address.com"} — find a Slack member ID '
            "under profile -> ... -> Copy member ID.",
            len(seen_jira_emails),
        )

    log.info("[REMINDER] resolved %d user->project mapping(s)", len(user_projects))
    log.debug(
        "[REMINDER] user->projects map: %s",
        {uid: sorted(ps) for uid, ps in user_projects.items()},
    )

    return user_projects


def _build_digest_blocks(pending_projects):
    """Reminder body listing all projects a user still owes a standup for."""
    bullets = "\n".join(
        f"• *{_format_project(p)}*" for p in sorted(pending_projects)
    )
    body = (
        "Good morning! You have standups pending for these projects:\n"
        f"{bullets}\n\nPlease submit one for each."
    )
    return _build_reminder_blocks("Daily Standup Reminder", body)


def _build_project_nudge_blocks(project_key):
    """Single-project follow-up reminder."""
    label = _format_project(project_key)
    body = (
        f"You haven't submitted today's standup for *{label}* yet — "
        "please submit it now."
    )
    return _build_reminder_blocks(f"Standup Reminder — {label}", body)


def send_standup_reminder():
    """Send standup reminders per project a user is active on.

    First ping of the day = one digest DM listing all pending projects.
    Later pings = one DM per still-pending project so each is harder to miss.
    """
    log.info(f"[REMINDER] Sending standup reminders...")
    members = get_all_slack_members()
    log.info(f"[REMINDER] Found {len(members)} members: {[m['name'] for m in members]}")

    if not members:
        log.info(f"[REMINDER] ERROR: No members found! Check SLACK_BOT_TOKEN and users:read scope.")
        return {"members_found": 0, "reason": "No Slack members returned — check SLACK_BOT_TOKEN and the users:read scope."}

    user_projects = _get_user_projects_map(members)
    if not user_projects:
        log.info(f"[REMINDER] No active Jira assignments found across projects. Nothing to remind.")
        return {
            "members_found": len(members),
            "matched_users": 0,
            "reason": (
                "No Slack member matched a Jira assignee. Either nothing is assigned "
                "on the board, or the two systems use different email addresses — "
                "map them with STANDUP_JIRA_USER_MAP."
            ),
        }

    today_str = date.today().isoformat()
    reminded = _reminded_today.setdefault(today_str, set())
    submitted_pairs = _users_submitted_today()

    digests_sent = nudges_sent = skipped_done = 0
    for member in members:
        uid = member["id"]
        projects = user_projects.get(uid, set())
        if not projects:
            continue

        pending = {p for p in projects if (uid, p) not in submitted_pairs}
        if not pending:
            skipped_done += 1
            continue

        first_time = uid not in reminded
        try:
            if first_time:
                pending_labels = [_format_project(p) for p in sorted(pending)]
                get_slack_client().chat_postMessage(
                    channel=uid,
                    text=f"Daily Standup Reminder — pending: {', '.join(pending_labels)}",
                    blocks=_build_digest_blocks(pending),
                )
                reminded.add(uid)
                digests_sent += 1
                print(
                    f"[SUCCESS] Digest sent to {member['name']} "
                    f"for {pending_labels}"
                )
            else:
                for project_key in sorted(pending):
                    label = _format_project(project_key)
                    get_slack_client().chat_postMessage(
                        channel=uid,
                        text=f"Standup reminder — {label} still pending",
                        blocks=_build_project_nudge_blocks(project_key),
                    )
                    nudges_sent += 1
                print(
                    f"[SUCCESS] {len(pending)} per-project follow-ups sent "
                    f"to {member['name']} for "
                    f"{[_format_project(p) for p in sorted(pending)]}"
                )
        except Exception as e:
            log.warning(f"Could not remind {member['name']}: {e}")

    log.info(
        "[REMINDER] %d digest(s), %d per-project follow-up(s), %d user(s) already done",
        digests_sent, nudges_sent, skipped_done,
    )
    return {
        "members_found": len(members),
        "matched_users": len(user_projects),
        "digests_sent": digests_sent,
        "nudges_sent": nudges_sent,
        "already_submitted": skipped_done,
    }


def check_missing_standups():
    """Check who hasn't submitted a standup today and send a follow-up."""
    print("[FOLLOWUP] Checking for missing standups...")

    today_str = date.today().isoformat()

    # Get today's submissions — Postgres first, JSON fallback (matches the write path).
    submitted_users = set()
    db_data = _load_standups_from_db()
    standup_data = db_data if db_data is not None else _load_standups_from_json()
    for entry in standup_data:
        if entry.get("timestamp", "").startswith(today_str):
            submitted_users.add(entry.get("user_id"))

    # Get all workspace members and find who hasn't submitted
    members = get_all_slack_members()
    missing = [m for m in members if m["id"] not in submitted_users]

    if not missing:
        print("[FOLLOWUP] All members have submitted their standups.")
        return

    blocks = _build_reminder_blocks(
        "Standup Follow-Up",
        "You haven't submitted your standup today. Please submit it now.",
    )
    for member in missing:
        try:
            get_slack_client().chat_postMessage(
                channel=member["id"],
                text="Standup follow-up — please submit your standup",  # fallback
                blocks=blocks,
            )
            log.info(f"Follow-up sent to {member['name']}")
        except Exception as e:
            log.warning(f"Could not follow up {member['name']}: {e}")

    print(
        f"[FOLLOWUP] {len(missing)}/{len(members)} members "
        "haven't submitted yet."
    )


# --- Test Endpoints ---


@app.route("/test/reminder", methods=["GET"])
def test_reminder():
    """Run the REAL scheduled reminder now and return what it did.

    This used to DM every workspace member unconditionally, which made it useless
    as a test: it passed whether or not the scheduled reminder worked, because it
    never touched the code the scheduler runs. A green result here while the daily
    reminder silently sent nothing is exactly the failure it should have caught.

    ?all=1 keeps the old blunt behaviour — a message to everyone, bypassing
    project matching — for checking Slack delivery in isolation.
    """
    if request.args.get("all") == "1":
        results = {"mode": "broadcast (bypasses project matching)",
                   "members_found": 0, "sent": [], "failed": [], "errors": []}
        try:
            members = get_all_slack_members()
            results["members_found"] = len(members)
            if not members:
                results["errors"].append(
                    "No members returned. Check SLACK_BOT_TOKEN and the users:read scope."
                )
                return jsonify(results), 200
            blocks = _build_reminder_blocks(
                "Daily Standup Reminder",
                "Good morning! Time to submit your daily standup.",
            )
            for member in members:
                try:
                    get_slack_client().chat_postMessage(
                        channel=member["id"],
                        text="Daily Standup Reminder — submit your standup",
                        blocks=blocks,
                    )
                    results["sent"].append(member["name"])
                except Exception as e:
                    results["failed"].append({"name": member["name"], "error": str(e)})
        except Exception as e:
            results["errors"].append(str(e))
        return jsonify(results), 200

    try:
        summary = send_standup_reminder() or {}
    except Exception as e:
        return jsonify({"mode": "scheduled reminder", "error": str(e)}), 200
    return jsonify({"mode": "scheduled reminder (same code path as the schedule)",
                    **summary}), 200


@app.route("/test/whoami/<slack_user_id>", methods=["GET"])
def test_whoami(slack_user_id):
    """Diagnose the Slack -> Jira identity mapping for one user.

    Ownership checks deny when a submitter cannot be matched to a Jira account,
    and the two systems frequently use different email addresses. This says
    exactly which lookup succeeded or why they all failed, without exposing
    anything beyond the caller's own workspace (gated by ADMIN_API_KEY).
    """
    account_id, how = resolve_submitter_jira_account(slack_user_id)
    profile = {}
    try:
        profile = get_slack_client().users_info(user=slack_user_id)["user"].get("profile", {}) or {}
    except Exception as e:
        profile = {"error": str(e)}
    return jsonify({
        "slackUserId": slack_user_id,
        "slackEmail": profile.get("email"),
        "slackRealName": profile.get("real_name"),
        "slackDisplayName": profile.get("display_name"),
        "explicitlyMapped": slack_user_id in JIRA_USER_MAP,
        "jiraAccountId": account_id,
        "resolvedBy" if account_id else "blockedBecause": how,
        "canMoveTickets": bool(account_id),
    })


@app.route("/test/followup", methods=["GET"])
def test_followup():
    """Manually trigger missing standup follow-up for testing."""
    check_missing_standups()
    return "Missing standup follow-up sent!", 200


@app.route("/test/stale", methods=["GET"])
def test_stale():
    """Manually trigger stale/pending task check for testing."""
    check_for_proactive_blockers()
    return "Stale/pending task check complete! Check console for results.", 200


# --- Scheduler ---
def _reminder_tz():
    """Resolve REMINDER_TIMEZONE, falling back to UTC rather than failing to boot.

    A bad tz name should not take the whole bot down — but it must be loud,
    because the reminder would silently fire five hours off.
    """
    try:
        return ZoneInfo(REMINDER_TIMEZONE)
    except Exception as e:
        log.error(
            "REMINDER_TIMEZONE=%r is not a valid IANA zone (%s). Falling back to "
            "UTC — the daily reminder will NOT fire at local %02d:%02d.",
            REMINDER_TIMEZONE, e, REMINDER_HOUR, REMINDER_MINUTE,
        )
        return ZoneInfo("UTC")


scheduler = BackgroundScheduler()
scheduler.add_job(check_for_proactive_blockers, "interval", days=1)

# Standup reminder cadence.
#
# Normally once a day at REMINDER_HOUR:REMINDER_MINUTE. Setting
# REMINDER_INTERVAL_MINUTES overrides that with a repeating interval, which is
# what you want when demonstrating or testing the bot — nobody can wait until
# 09:30 tomorrow to see whether a fix worked.
#
# Anyone who has already submitted for a project is skipped, so this re-nudges
# only the people who still owe a standup. It is still a DM to real people every
# N minutes: set it back to blank once you are done.
if REMINDER_INTERVAL_MINUTES > 0:
    log.warning(
        "[REMINDER] Running every %d minute(s) because REMINDER_INTERVAL_MINUTES "
        "is set. This DMs everyone who still owes a standup, on every run. "
        "Unset it to return to the daily %02d:%02d schedule.",
        REMINDER_INTERVAL_MINUTES, REMINDER_HOUR, REMINDER_MINUTE,
    )
    scheduler.add_job(send_standup_reminder, "interval", minutes=REMINDER_INTERVAL_MINUTES)
else:
    _tz = _reminder_tz()
    log.info(
        "[REMINDER] Daily standup reminder scheduled for %02d:%02d %s",
        REMINDER_HOUR, REMINDER_MINUTE, _tz,
    )
    scheduler.add_job(
        send_standup_reminder,
        CronTrigger(hour=REMINDER_HOUR, minute=REMINDER_MINUTE, timezone=_tz),
    )

scheduler.add_job(check_missing_standups, "interval", days=1)
# Keep the Jira project list warm so /standup never has to call Jira inline.
scheduler.add_job(refresh_jira_projects_cache, "interval", minutes=5)
scheduler.start()

# Prime the cache on startup (in the background — never block boot).
background_executor.submit(refresh_jira_projects_cache)

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "3000"))
    print(f"Standup bot dev server: http://{host}:{port}")
    print("For production, run behind a real WSGI server, e.g.:")
    print(f"  waitress-serve --host={host} --port={port} --threads=8 app:app")
    app.run(host=host, port=port)
