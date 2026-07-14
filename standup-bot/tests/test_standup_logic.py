"""Regression tests for standup processing — Gemini/Slack/Jira fully mocked.

Critical setup order:
  1. Dummy env vars are set BEFORE importing app (app.py's load_dotenv() does
     not override pre-set env), so no real tokens are ever used.
  2. BackgroundScheduler.start is patched to a no-op BEFORE import — app.py
     starts its scheduler at module level (the 2-minute reminder job must
     never run inside a test).
  3. JIRA_URL/EXPRESS_DB_URL point at a dead local port so the module-level
     cache-priming thread fails instantly and harmlessly.

Run from standup-bot/:  .venv/Scripts/python.exe -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 1) Dummy env BEFORE app import (load_dotenv() won't override these).
os.environ.setdefault("SLACK_BOT_TOKEN", "xoxb-test-dummy")
os.environ["GEMINI_API_KEY"] = "test-dummy-key"
os.environ["JIRA_URL"] = "http://127.0.0.1:9"
os.environ["JIRA_EMAIL"] = "tester@example.com"
os.environ["JIRA_API_TOKEN"] = "dummy"
os.environ["JIRA_PROJECT_KEY"] = "SCRUM"
os.environ["EXPRESS_DB_URL"] = "http://127.0.0.1:9/api/db/standups"
os.environ["SLACK_BOT_TOKEN"] = "xoxb-test-dummy"

# 2) Neutralize the module-level scheduler before app import.
from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402

BackgroundScheduler.start = lambda self, *a, **k: None

import app  # noqa: E402


def gemini_response(payload, fenced=True):
    """Build a mock Gemini response object with .text."""
    raw = json.dumps(payload)
    if fenced:
        raw = f"```json\n{raw}\n```"
    resp = MagicMock()
    resp.text = raw
    return resp


BASE_ANALYSIS = {
    "is_blocker": False,
    "blocker_summary": None,
    "finished_tickets": [],
    "today_tickets": [],
    "sentiment": "Positive",
}


class ProcessStandupLogicTests(unittest.TestCase):
    def setUp(self):
        # Fresh mocks per test — swap module-level collaborators.
        self._orig = {
            name: getattr(app, name)
            for name in (
                "gemini_client", "slack_client", "move_jira_ticket",
                "create_blocker_ticket", "get_jira_account_id",
                "save_standup_to_json", "send_to_standup_analyzer",
            )
        }
        app.gemini_client = MagicMock()
        app.slack_client = MagicMock()
        app.slack_client.users_info.return_value = {
            "user": {"profile": {"email": "tester@example.com"}, "real_name": "Tester"}
        }
        app.move_jira_ticket = MagicMock(side_effect=lambda tid, status, acct: f"- {tid} -> {status}")
        app.create_blocker_ticket = MagicMock(return_value="- Blocker ticket created")
        app.get_jira_account_id = MagicMock(return_value="acct-123")
        app.save_standup_to_json = MagicMock(return_value={"user_id": "U1"})
        app.send_to_standup_analyzer = MagicMock()

    def tearDown(self):
        for name, value in self._orig.items():
            setattr(app, name, value)

    def run_logic(self, project="FINAL", yesterday="", today="", blocker="none",
                  analysis=None, raw_text=None):
        if raw_text is not None:
            resp = MagicMock()
            resp.text = raw_text
        else:
            resp = gemini_response(analysis or BASE_ANALYSIS)
        app.gemini_client.models.generate_content.return_value = resp
        app.process_standup_logic("U1", project, yesterday, today, blocker)

    def moved(self):
        return [(c.args[0], c.args[1]) for c in app.move_jira_ticket.call_args_list]

    # ── Regex safety net (the WIP feature under protection) ──────────────────

    def test_loose_ticket_references_are_extracted_even_when_gemini_misses(self):
        self.run_logic(
            yesterday="I finished final 3 and FINAL-4 is done",
            today="will start final5 and then final 6",
        )
        self.assertEqual(self.moved(), [
            ("FINAL-3", "Done"),
            ("FINAL-4", "Done"),
            ("FINAL-5", "In Progress"),
            ("FINAL-6", "In Progress"),
        ])

    def test_merge_dedupes_gemini_and_regex_results(self):
        analysis = dict(BASE_ANALYSIS, finished_tickets=["FINAL-3"])
        self.run_logic(yesterday="wrapped up final 3", analysis=analysis)
        self.assertEqual(self.moved(), [("FINAL-3", "Done")])

    def test_quantities_without_project_prefix_are_not_tickets(self):
        self.run_logic(
            project="SCRUM",
            yesterday="spent 3 hours fixing 2 bugs",
            today="reviewing 5 PRs",
        )
        self.assertEqual(self.moved(), [])

    def test_fenced_json_is_stripped(self):
        # BASE run already uses ```json fences; assert the happy path completed.
        self.run_logic(yesterday="finished final 1")
        self.assertEqual(self.moved(), [("FINAL-1", "Done")])
        app.slack_client.chat_postMessage.assert_called_once()

    # ── Blocker + report behavior ────────────────────────────────────────────

    def test_blocker_creates_ticket_and_report_mentions_it(self):
        analysis = dict(
            BASE_ANALYSIS,
            is_blocker=True,
            blocker_summary="Payments API is down",
            blocker_type="Dependency",
            impact="Sprint at risk",
        )
        self.run_logic(blocker="payments api down", analysis=analysis)
        app.create_blocker_ticket.assert_called_once()
        text = app.slack_client.chat_postMessage.call_args.kwargs["text"]
        self.assertIn("Blocker Detected", text)
        self.assertIn("Dependency", text)

    def test_report_dm_contains_tickets_and_saves_standup(self):
        self.run_logic(yesterday="finished final 2", today="starting final 7")
        text = app.slack_client.chat_postMessage.call_args.kwargs["text"]
        self.assertIn("FINAL-2", text)
        self.assertIn("FINAL-7", text)
        app.save_standup_to_json.assert_called_once()

    # ── Failure path ─────────────────────────────────────────────────────────

    def test_invalid_gemini_json_sends_warning_not_crash(self):
        self.run_logic(yesterday="finished final 3", raw_text="totally not json")
        self.assertEqual(self.moved(), [])  # bailed before Jira actions
        text = app.slack_client.chat_postMessage.call_args.kwargs["text"]
        self.assertIn("Standup processing failed", text)


class HttpEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_health_endpoint(self):
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["status"], "running")

    def test_api_standup_requires_fields(self):
        resp = self.client.post("/api/standup", json={"user_id": "U1"})
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
