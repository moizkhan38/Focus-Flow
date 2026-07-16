"""Regression tests for the Flask epic-generator service.

Covers: description validation (mirrored in frontend + Express), markdown
stripping, the regex parser for Gemini output, and validation-path HTTP
behavior via Flask's test client. No Gemini calls are made — validation
rejects requests before the model is reached.

Run from epic-generator/:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import web_app  # noqa: E402  (module import boots the Flask app; no server, no Gemini call)

VALID_DESC = (
    "Build a fitness tracking mobile application with workout logging, "
    "nutrition tracking, and progress analytics"
)

TWO_EPIC_FIXTURE = """
Epic E1: User Authentication
Description: Secure login and session management system
User Story E1-US1: Login form
Description: As a user, I want to log in with email and password
Story Points: 5
Acceptance Criteria: Given valid credentials, the user is logged in
Test Case ID: E1-US1-TC1
Test Case Description: Valid login succeeds
- Preconditions: User account exists
- Test Data: user@example.com / correct-password
- User Action: Submit the login form
Expected Result:
1. User is redirected to the dashboard
2. A session token is created

User Story E1-US2: Logout
Description: As a user, I want to log out securely
Story Points: 3
Acceptance Criteria: Session is cleared on logout

Epic E2: Reporting
Description: Analytics and report exports
User Story E2-US1: Export PDF
Description: As a manager, I want to export reports as PDF
Story Points: 8
Acceptance Criteria: A PDF downloads with the report contents
"""


class CheckDescriptionTests(unittest.TestCase):
    def test_empty_is_required(self):
        self.assertEqual(web_app.check_description(None), "Project description is required")
        self.assertEqual(web_app.check_description("   "), "Project description is required")

    def test_too_short(self):
        err = web_app.check_description("Build an app")
        self.assertIn("too short", err)

    def test_too_long(self):
        err = web_app.check_description("a" * 4001)
        self.assertIn("too long", err)

    def test_placeholder_rejected(self):
        err = web_app.check_description("this is a placeholder description for the project")
        self.assertIn("meaningful description", err)

    def test_gibberish_rejected(self):
        err = web_app.check_description("asdfgh qwerty zxcvbn poiuyt lkjhgf mnbvcx")
        self.assertIn("meaningful description", err)

    def test_valid_passes(self):
        self.assertIsNone(web_app.check_description(VALID_DESC))

    def test_constants_match_cross_layer_contract(self):
        self.assertEqual(web_app.MIN_DESCRIPTION_LENGTH, 30)
        self.assertEqual(web_app.MAX_DESCRIPTION_LENGTH, 4000)
        self.assertEqual(web_app.MIN_MEANINGFUL_WORDS, 5)


class StripMarkdownTests(unittest.TestCase):
    def test_strips_bold_italic_heading_code_hr(self):
        text = "## Epic E1: **Login**\n*important* `code` here\n---\nplain"
        out = web_app._strip_markdown(text)
        self.assertNotIn("**", out)
        self.assertNotIn("##", out)
        self.assertNotIn("`", out)
        self.assertIn("Epic E1: Login", out)
        self.assertIn("important code here", out)


class ParseMultipleEpicsTests(unittest.TestCase):
    def setUp(self):
        self.result = web_app.parse_multiple_epics(TWO_EPIC_FIXTURE)

    def test_finds_both_epics(self):
        epics = self.result["epics"]
        self.assertEqual(len(epics), 2)
        self.assertEqual(epics[0]["epic_id"], "E1")
        self.assertEqual(epics[0]["epic_title"], "User Authentication")
        self.assertEqual(epics[1]["epic_id"], "E2")
        self.assertEqual(epics[1]["epic_title"], "Reporting")

    def test_epic_description_extracted(self):
        self.assertIn("Secure login", self.result["epics"][0]["epic_description"])

    def test_stories_with_points(self):
        e1_stories = self.result["epics"][0]["user_stories"]
        self.assertEqual(len(e1_stories), 2)
        self.assertEqual(e1_stories[0]["story_id"], "E1-US1")
        self.assertEqual(e1_stories[0]["story_points"], "5")
        self.assertEqual(e1_stories[1]["story_id"], "E1-US2")
        self.assertEqual(e1_stories[1]["story_points"], "3")
        e2_stories = self.result["epics"][1]["user_stories"]
        self.assertEqual(len(e2_stories), 1)
        self.assertEqual(e2_stories[0]["story_points"], "8")

    def test_acceptance_criteria(self):
        story = self.result["epics"][0]["user_stories"][0]
        self.assertIn("valid credentials", story["acceptance_criteria"])

    def test_test_case_parsed_with_expected_results(self):
        tcs = self.result["epics"][0]["user_stories"][0]["test_cases"]
        self.assertEqual(len(tcs), 1)
        tc = tcs[0]
        self.assertEqual(tc["test_case_id"], "E1-US1-TC1")
        self.assertEqual(len(tc["expected_results"]), 2)
        self.assertIn("dashboard", tc["expected_results"][0])

    def test_markdown_wrapped_output_still_parses(self):
        wrapped = TWO_EPIC_FIXTURE.replace("Epic E1:", "## **Epic E1:**")
        result = web_app.parse_multiple_epics(wrapped)
        self.assertEqual(len(result["epics"]), 2)
        self.assertEqual(result["epics"][0]["epic_id"], "E1")

    def test_raw_text_preserved(self):
        self.assertEqual(self.result["raw_text"], TWO_EPIC_FIXTURE)


class HttpValidationTests(unittest.TestCase):
    """Validation-path HTTP behavior. These never reach Gemini."""

    def setUp(self):
        self.client = web_app.app.test_client()
        # The internal-key gate (step 0.3) turns on whenever INTERNAL_API_KEY is
        # set in the environment — which it is on any machine with a real .env.
        # These tests target validation, not the gate, so present the key when
        # it's configured. Without this they 401 instead of 400, and whether the
        # suite passes depends on the developer's .env rather than the code.
        self.headers = (
            {"X-Internal-Key": web_app.INTERNAL_API_KEY} if web_app.INTERNAL_API_KEY else {}
        )

    def test_health_returns_200(self):
        # Health is exempt from the gate — assert that by sending no key.
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)

    def test_gated_when_key_configured(self):
        if not web_app.INTERNAL_API_KEY:
            self.skipTest("INTERNAL_API_KEY unset — gate inactive in this environment")
        resp = self.client.post("/api/generate", json={})
        self.assertEqual(resp.status_code, 401)

    def test_generate_empty_description_400(self):
        resp = self.client.post("/api/generate", json={}, headers=self.headers)
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(resp.get_json()["success"])

    def test_generate_short_description_400(self):
        resp = self.client.post(
            "/api/generate", json={"description": "Build an app"}, headers=self.headers
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("too short", resp.get_json()["error"])

    def test_generate_placeholder_400(self):
        resp = self.client.post(
            "/api/generate",
            json={"description": "this is a placeholder description for the project"},
            headers=self.headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_regenerate_missing_fields_400(self):
        resp = self.client.post("/api/regenerate", json={}, headers=self.headers)
        self.assertEqual(resp.status_code, 400)

    def test_classify_missing_fields_400(self):
        resp = self.client.post("/api/classify", json={}, headers=self.headers)
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
