import os
import re
import json
from concurrent.futures import ThreadPoolExecutor
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

# Resolve the data file relative to this script, not the process CWD.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STANDUP_JSON_PATH = os.path.join(BASE_DIR, "standup_data.json")

# --- Security / runtime config ---
SLACK_SIGNING_SECRET = os.environ.get("SLACK_SIGNING_SECRET", "")
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")   # gates /api/standup* (Express → bot)
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")         # gates /test/* (hidden unless set)
FLASK_DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
REMINDER_HOUR = int(os.environ.get("REMINDER_HOUR", "9"))
REMINDER_MINUTE = int(os.environ.get("REMINDER_MINUTE", "30"))

# Slack request signature verification. Without the signing secret anyone who can
# reach the endpoint could forge Slack requests, so refuse to start in production.
signature_verifier = SignatureVerifier(SLACK_SIGNING_SECRET) if SLACK_SIGNING_SECRET else None
if not SLACK_SIGNING_SECRET and not FLASK_DEBUG:
    raise SystemExit(
        "[FATAL] SLACK_SIGNING_SECRET is required. Set it (see .env.example), or set "
        "FLASK_DEBUG=true for local dev. Refusing to start without Slack request verification."
    )

app = Flask(__name__)


@app.before_request
def _gate_requests():
    path = request.path
    # Slack endpoints: prove the request genuinely came from Slack.
    if path.startswith("/slack/"):
        if signature_verifier is None:
            return None  # dev only — prod refuses to start without the secret
        if not signature_verifier.is_valid_request(request.get_data(), dict(request.headers)):
            return jsonify({"error": "invalid Slack signature"}), 401
        return None
    # Internal server-to-server endpoints (Express → bot). No-op when key unset (dev).
    if path == "/api/standup" or path.startswith("/api/standup/"):
        if INTERNAL_API_KEY and request.headers.get("X-Internal-Key") != INTERNAL_API_KEY:
            return jsonify({"error": "unauthorized"}), 401
        return None
    # Test/admin endpoints: hidden (404) unless an admin key is set AND matches.
    if path.startswith("/test/"):
        if not ADMIN_API_KEY or request.headers.get("X-Admin-Key") != ADMIN_API_KEY:
            return jsonify({"error": "not found"}), 404
        return None
    return None


# Initialize Clients
slack_client = WebClient(token=os.environ.get("SLACK_BOT_TOKEN"))
gemini_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-flash-lite-latest')  # lite alias: free-tier quota + never 404-deprecates
jira = Jira(
    url=os.environ.get("JIRA_URL"),
    username=os.environ.get("JIRA_EMAIL"),
    password=os.environ.get("JIRA_API_TOKEN"),
    cloud=True,
)

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
        projects = jira.get("rest/api/3/project")
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
        print(f"[JIRA-CACHE] Refreshed {len(options)} project options")
    except Exception as e:
        print(f"[JIRA-CACHE] Refresh failed: {e}")
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


# --- Jira Actions ---


def verify_ticket_exists(ticket_id):
    """Check if a Jira ticket exists and user has access to it."""
    try:
        jira.issue(ticket_id)
        return True
    except Exception:
        return False


def get_ticket_assignee(ticket_id):
    """Get the assignee info of a Jira ticket. Returns (account_id, name)."""
    try:
        issue = jira.issue(ticket_id)
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
        users = jira.user_find_by_user_string(query=email)
        if users:
            return users[0].get("accountId")
        return None
    except Exception:
        return None


def move_jira_ticket(ticket_id, status_name, user_account_id=None):
    """Transition a Jira ticket to the given status after ownership check."""
    try:
        ticket_id = ticket_id.upper().strip()

        if not verify_ticket_exists(ticket_id):
            return (
                f"[SKIPPED] {ticket_id}: "
                "Issue does not exist or you don't have permission"
            )

        # Check if ticket is assigned to the submitting user
        if user_account_id:
            assignee_id, assignee_name = get_ticket_assignee(ticket_id)
            if assignee_id is None:
                return (
                    f"[DENIED] {ticket_id}: "
                    "This ticket has no assignee"
                )
            if assignee_id != user_account_id:
                return (
                    f"[DENIED] {ticket_id}: "
                    f"This ticket is assigned to {assignee_name}, "
                    "so you cannot move it. Please update the ticket or contact the assignee."
                )

        jira.issue_transition(ticket_id, status_name)
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
        new_issue = jira.create_issue(fields=issue_dict)
        return f"[BLOCKER] Created Blocker Ticket: {new_issue['key']}"
    except Exception as e:
        return f"[ERROR] Failed to create blocker: {e}"


# --- Background Logic ---


EXPRESS_DB_URL = os.environ.get("EXPRESS_DB_URL", "http://localhost:3003/api/db/standups")
# Clerk org this bot's standups belong to (single-workspace deployment binding, D6).
STANDUP_ORG_ID = os.environ.get("STANDUP_ORG_ID", "")


def _express_headers():
    """Auth headers for server-to-server calls into the Express API (1.4 lane)."""
    headers = {}
    if INTERNAL_API_KEY:
        headers["X-Internal-Key"] = INTERNAL_API_KEY
    if STANDUP_ORG_ID:
        headers["X-Org-Id"] = STANDUP_ORG_ID
    return headers


def save_standup_to_json(user_id, project_key, yesterday, today, blocker, analysis):
    """Save standup to Postgres via Express backend; fall back to JSON on failure."""
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
            print(f"[SUCCESS] Saved standup to DB for {user_id}")
            return new_entry
        print(f"[WARN] DB save returned {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"[WARN] DB save failed, falling back to JSON: {e}")

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
        print(f"[FALLBACK] Saved standup to JSON for {user_id}")
        return new_entry
    except Exception as e:
        print(f"[ERROR] Failed to save standup anywhere: {e}")
        return None


def send_to_standup_analyzer(standup_entry):
    """Send standup data to analyzer endpoint."""
    try:
        analyzer_url = os.environ.get("STANDUP_ANALYZER_URL")
        if not analyzer_url:
            print("[WARNING] STANDUP_ANALYZER_URL not configured")
            return

        response = requests.post(
            analyzer_url, json=standup_entry, timeout=3
        )
        if response.status_code == 200:
            print("[SUCCESS] Sent standup data to analyzer")
        else:
            print(
                f"[WARNING] Analyzer responded with status "
                f"{response.status_code}"
            )
    except Exception as e:
        print(f"[ERROR] Failed to send to analyzer: {e}")


def process_standup_logic(user_id, project_key, yesterday, today, blocker):
    """Core standup processing: AI analysis, Jira updates, Slack report."""
    print(f"[BACKGROUND] Analyzing standup for {user_id} ({project_key})...")

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
        print(
            f"[DEBUG] project_key={project_key!r} "
            f"yesterday={yesterday!r} -> regex {regex_finished}, "
            f"today={today!r} -> regex {regex_today}, "
            f"gemini finished={analysis.get('finished_tickets')}, "
            f"gemini today={analysis.get('today_tickets')}"
        )
        analysis["finished_tickets"] = _merge(
            analysis.get("finished_tickets"), regex_finished
        )
        analysis["today_tickets"] = _merge(
            analysis.get("today_tickets"), regex_today
        )

        # Get the user's Jira account ID for ownership check
        jira_email = os.environ.get("JIRA_EMAIL")
        try:
            user_info = slack_client.users_info(user=user_id)
            user_profile = user_info["user"]["profile"]
            user_email = user_profile.get("email", jira_email)
        except Exception:
            user_email = jira_email
        user_account_id = get_jira_account_id(user_email)

        # Jira execution
        results = []

        for tid in analysis.get("finished_tickets", []):
            res = move_jira_ticket(tid, "Done", user_account_id)
            results.append(res)

        for tid in analysis.get("today_tickets", []):
            res = move_jira_ticket(tid, "In Progress", user_account_id)
            results.append(res)

        if analysis.get("is_blocker"):
            res = create_blocker_ticket(
                analysis.get("blocker_summary"), blocker, project_key
            )
            results.append(res)

        # Save standup data
        standup_entry = save_standup_to_json(
            user_id, project_key, yesterday, today, blocker, analysis
        )

        # Get user's real name (reuse user_info from above)
        try:
            user_name = user_info["user"]["real_name"]
        except Exception:
            user_name = user_id

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

        blocker_section = ""
        if analysis.get("is_blocker"):
            blocker_section = (
                "\n\n*Blocker Detected:*\n"
                f"- *Type:* {analysis.get('blocker_type', 'Unknown')}\n"
                f"- *Impact:* {analysis.get('impact', 'Unknown')}\n"
                f"- *Details:* {analysis.get('blocker_summary', 'N/A')}"
            )

        slack_client.chat_postMessage(
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
                f"_Standup data saved and sent to analyzer._"
            ),
        )

        # Send to analyzer in background (non-critical)
        if standup_entry:
            background_executor.submit(send_to_standup_analyzer, standup_entry)

    except Exception as e:
        import traceback
        print(f"[ERROR] Logic Error: {type(e).__name__}: {e}")
        traceback.print_exc()
        slack_client.chat_postMessage(
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
        print(f"[ERROR] Analyzer Error: {e}")
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
        slack_client.views_open(trigger_id=trigger_id, view=modal)
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
                info = slack_client.users_info(user=entry['user_id'])
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
        projects = jira.get("rest/api/3/project")
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
                issues = jira.jql(check["jql"])["issues"]
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
                        user_info = slack_client.users_lookupByEmail(
                            email=assignee_email
                        )
                        user_id = user_info["user"]["id"]

                        nudge_text = check["message"].format(
                            key=key,
                            summary=summary,
                            status=status,
                            project=project_key,
                        )
                        slack_client.chat_postMessage(
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
                print(f"[ERROR] Scan Error for {project_key}: {e}")


# --- Standup Reminders ---


def get_all_slack_members():
    """Get all real (non-bot, non-deleted) Slack workspace members."""
    members = []
    try:
        result = slack_client.users_list()
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
        print(f"[ERROR] Failed to fetch Slack members: {e}")
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
    email_to_uid = {m["email"]: m["id"] for m in members if m.get("email")}
    print(f"[REMINDER-DEBUG] Slack members with email: {list(email_to_uid.keys())}")
    members_without_email = [m["name"] for m in members if not m.get("email")]
    if members_without_email:
        print(
            f"[REMINDER-DEBUG] WARNING: Slack members WITHOUT email "
            f"(check users:read.email scope): {members_without_email}"
        )

    user_projects = {}
    seen_jira_emails = set()

    project_options = get_cached_project_options()
    project_keys = [opt.get("value") for opt in project_options if opt.get("value")]

    for key in project_keys:
        try:
            jql = (
                f'project = "{key}" AND statusCategory != Done '
                f'AND assignee IS NOT EMPTY'
            )
            result = jira.jql(jql, fields="assignee", limit=1000)
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
            print(f"[REMINDER] Could not fetch assignees for {key}: {e}")

    unmatched = seen_jira_emails - set(email_to_uid.keys())
    if unmatched:
        print(
            f"[REMINDER-DEBUG] Jira assignee emails NOT matched to any Slack user: "
            f"{sorted(unmatched)}"
        )
    print(f"[REMINDER-DEBUG] Final user->projects map: { {uid: sorted(ps) for uid, ps in user_projects.items()} }")

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
    print("[REMINDER] Sending standup reminders...")
    members = get_all_slack_members()
    print(f"[REMINDER] Found {len(members)} members: {[m['name'] for m in members]}")

    if not members:
        print("[REMINDER] ERROR: No members found! Check SLACK_BOT_TOKEN and users:read scope.")
        return

    user_projects = _get_user_projects_map(members)
    if not user_projects:
        print("[REMINDER] No active Jira assignments found across projects. Nothing to remind.")
        return

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
                slack_client.chat_postMessage(
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
                    slack_client.chat_postMessage(
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
            print(f"[WARNING] Could not remind {member['name']}: {e}")

    print(
        f"[REMINDER] {digests_sent} digests, {nudges_sent} per-project follow-ups, "
        f"{skipped_done} users already done"
    )


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
            slack_client.chat_postMessage(
                channel=member["id"],
                text="Standup follow-up — please submit your standup",  # fallback
                blocks=blocks,
            )
            print(f"[SUCCESS] Follow-up sent to {member['name']}")
        except Exception as e:
            print(f"[WARNING] Could not follow up {member['name']}: {e}")

    print(
        f"[FOLLOWUP] {len(missing)}/{len(members)} members "
        "haven't submitted yet."
    )


# --- Test Endpoints ---


@app.route("/test/reminder", methods=["GET"])
def test_reminder():
    """Manually trigger standup reminder for testing with diagnostics."""
    results = {"members_found": 0, "sent": [], "failed": [], "errors": []}

    try:
        members = get_all_slack_members()
        results["members_found"] = len(members)

        if not members:
            results["errors"].append("No members returned. Check SLACK_BOT_TOKEN and users:read scope.")
            return jsonify(results), 200

        blocks = _build_reminder_blocks(
            "Daily Standup Reminder",
            "Good morning! Time to submit your daily standup.",
        )
        for member in members:
            try:
                slack_client.chat_postMessage(
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
scheduler = BackgroundScheduler()
scheduler.add_job(check_for_proactive_blockers, "interval", days=1)
# Daily standup reminder at REMINDER_HOUR:REMINDER_MINUTE (default 09:30).
scheduler.add_job(send_standup_reminder, CronTrigger(hour=REMINDER_HOUR, minute=REMINDER_MINUTE))
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
