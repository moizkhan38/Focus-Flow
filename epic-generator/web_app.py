"""
Flask Web Application for Epic/Story Generator
Run this to start a web interface for your AI model
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from src.gemini_generator import GeminiEpicGenerator
from dotenv import load_dotenv
import os
import re
import sys
import logging

load_dotenv(override=True)

# Structured, level-controlled logging (Phase 3, step 3.2). LOG_LEVEL env
# (default INFO) also governs Flask/Werkzeug request logs. Timestamps included.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("epic-generator")

app = Flask(__name__)

# CORS restricted to the Express gateway (and dev frontend). Flask is an internal
# service — it must never be called directly by a browser in production.
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS", "http://localhost:3003,http://localhost:5173"
).split(",") if o.strip()]
CORS(app, origins=CORS_ORIGINS)

# Internal-key gate: when INTERNAL_API_KEY is set (production), every /api/* call
# except the health check must present a matching X-Internal-Key header. Express
# sends it (see services/flaskProxy.js). Unset in local dev → no gating.
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")


@app.before_request
def _require_internal_key():
    if not INTERNAL_API_KEY:
        return None
    if request.method == 'OPTIONS' or not request.path.startswith('/api/'):
        return None
    if request.path == '/api/health':
        return None
    if request.headers.get('X-Internal-Key') != INTERNAL_API_KEY:
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    return None

# Keep in sync with frontend (frontend/src/utils/descriptionValidator.js)
# and Express (epic-dev-assignment/backend/routes/epics.js).
MIN_DESCRIPTION_LENGTH = 30
MAX_DESCRIPTION_LENGTH = 4000
MIN_MEANINGFUL_WORDS = 5

_PLACEHOLDER_PATTERNS = [
    re.compile(r'\bno description\b', re.I),
    re.compile(r'\bnot available\b', re.I),
    re.compile(r'\bnot provided\b', re.I),
    re.compile(r'\blorem ipsum\b', re.I),
    re.compile(r'\bplaceholder\b', re.I),
    re.compile(r'^\s*(n/a|na|tbd|none|nothing|test|asdf|qwerty|idk|hello world)\s*\.?\s*$', re.I),
]

_STOPWORDS = {
    'a','an','the','and','or','of','to','in','on','at','by','for','with','as','from','into',
    'is','are','was','were','be','been','being','have','has','had','do','does','did',
    'will','would','can','could','should','may','might','must','that','this','these','those',
    'it','its','no','not','but','if','when','where','what','who','our','your','their','they','them',
}

_PRODUCT_TERMS = {
    'app','apps','application','applications','system','platform','website','site','sites',
    'dashboard','tool','tools','service','services','software','product','portal','marketplace',
    'store','shop','blog','forum','network','game','bot','chatbot','assistant',
    'mobile','web','desktop','cli','api','sdk',
    'extension','plugin','library','framework','engine','pipeline','generator',
    'tracker','manager','scheduler','planner','calculator','editor','viewer',
    'management','analytics','crm','cms','erp',
}

_ACTION_VERBS = {
    'build','create','develop','make','design','implement','launch','deploy',
    'generate','automate','integrate','manage','track','monitor','organize',
    'schedule','analyze','process','support','provide','enable',
}

_TOKEN_RE = re.compile(r"[a-z][a-z'-]*")

_MEANINGFUL_ERROR = (
    'Please provide a meaningful description with real features — '
    'describe what to build (e.g. app, platform, system) and its main features.'
)


def check_description(description):
    value = (description or '').strip()
    if len(value) == 0:
        return 'Project description is required'
    if len(value) < MIN_DESCRIPTION_LENGTH:
        return f'Description is too short — minimum {MIN_DESCRIPTION_LENGTH} characters.'
    if len(value) > MAX_DESCRIPTION_LENGTH:
        return f'Description is too long — maximum {MAX_DESCRIPTION_LENGTH} characters.'
    if any(p.search(value) for p in _PLACEHOLDER_PATTERNS):
        return _MEANINGFUL_ERROR
    tokens = _TOKEN_RE.findall(value.lower())
    meaningful = {t for t in tokens if len(t) >= 4 and t not in _STOPWORDS}
    has_product = any(t in _PRODUCT_TERMS for t in tokens)
    has_action = any(t in _ACTION_VERBS for t in tokens)
    if len(meaningful) < MIN_MEANINGFUL_WORDS or not (has_product or has_action):
        return _MEANINGFUL_ERROR
    return None

# Configuration - Google Gemini API Key
# Set your API key as environment variable: GEMINI_API_KEY
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Confirm the key is present without ever logging any part of its value.
if GEMINI_API_KEY:
    log.info(f"GEMINI_API_KEY loaded")
    sys.stdout.flush()
else:
    log.warning(f"No GEMINI_API_KEY found in environment!")
    sys.stdout.flush()

# Global model instances (load once when server starts)
print("="*80)
print("INITIALIZING AI GENERATORS")
print("="*80)

# Initialize Gemini API generator (primary)
print("\nInitializing Google Gemini API Generator...")
try:
    gemini_generator = GeminiEpicGenerator(api_key=GEMINI_API_KEY)
    log.info(f"Gemini API Generator ready!")
except Exception as e:
    log.error(f"Gemini API initialization failed: {e}")
    gemini_generator = None

print("\n" + "="*80)
print("GENERATOR STATUS:")
print(f"  Gemini API:  {'[READY]' if gemini_generator else '[UNAVAILABLE]'}")
print("="*80)


# ─── Per-organization key override (D5) ──────────────────────────────────────
# The platform key above stays the default. When an organization has connected
# its own Gemini key in the Integrations page, the backend forwards it as
# X-Gemini-Key and that key is used for this request only. Generators are cached
# per key so a repeat caller does not pay client construction on every request.
_generator_cache = {}
_GENERATOR_CACHE_MAX = 32


def generator_for_request():
    """Generator for the caller's key, falling back to the platform generator.

    Never logs key material. Returns None only if neither a per-request key nor
    the platform generator is usable, which the routes report as unavailable.
    """
    key = request.headers.get("X-Gemini-Key", "").strip()
    if not key:
        return gemini_generator

    cached = _generator_cache.get(key)
    if cached is not None:
        return cached

    try:
        gen = GeminiEpicGenerator(api_key=key)
    except Exception as e:
        # Fall back rather than fail: a bad org key should degrade to the
        # platform key, not break generation outright.
        log.warning(f"Per-org Gemini key rejected ({type(e).__name__}); using platform key")
        return gemini_generator

    # Bounded cache — evict oldest insertion when full.
    if len(_generator_cache) >= _GENERATOR_CACHE_MAX:
        _generator_cache.pop(next(iter(_generator_cache)), None)
    _generator_cache[key] = gen
    return gen
print("\nWeb server starting...")


def _strip_markdown(text: str) -> str:
    """Strip markdown formatting from LLM output so regex parsers work correctly."""
    import re
    # Remove bold/italic markers
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'\1', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    # Remove heading markers
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    # Remove backtick formatting
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Remove horizontal rules
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    return text


def parse_multiple_epics(text: str) -> dict:
    """
    Parse comprehensive output with MULTIPLE Epics, User Stories, and Test Cases
    Returns a structured format for displaying all epics
    """
    import re

    result = {
        "epics": [],
        "raw_text": text
    }

    # Strip markdown formatting before parsing
    text = _strip_markdown(text)

    # Split text by Epic markers to find all epics
    epic_sections = re.split(r'(?=Epic E\d+:)', text)

    for section in epic_sections:
        if not section.strip() or 'Epic E' not in section:
            continue

        epic_data = {
            "epic_id": "",
            "epic_title": "",
            "epic_description": "",
            "user_stories": []
        }

        # Extract Epic ID and Title
        epic_match = re.search(r'Epic\s+(E\d+):\s*([^\n]+)', section, re.IGNORECASE)
        if epic_match:
            epic_data["epic_id"] = epic_match.group(1)
            epic_data["epic_title"] = epic_match.group(2).strip()

        # Extract Epic Description
        epic_desc_match = re.search(r'Description:\s*([^\n]+(?:\n(?!User Story|Epic E\d+)[^\n]+)*)', section, re.IGNORECASE)
        if epic_desc_match:
            epic_data["epic_description"] = epic_desc_match.group(1).strip()

        # Find all user stories in this epic
        story_sections = re.split(r'(?=User Story\s+E\d+-US\d+)', section)

        for story_section in story_sections:
            if not story_section.strip() or 'User Story' not in story_section:
                continue

            story_data = {
                "story_id": "",
                "story_title": "",
                "story_description": "",
                "story_points": "",
                "acceptance_criteria": "",
                "test_cases": []
            }

            # Extract User Story ID and Title
            story_match = re.search(r'User Story\s+(E\d+-US\d+):\s*([^\n]+)', story_section, re.IGNORECASE)
            if story_match:
                story_data["story_id"] = story_match.group(1)
                story_data["story_title"] = story_match.group(2).strip()

            # Extract User Story Description
            story_desc_match = re.search(r'User Story.*?Description:\s*([^\n]+(?:\n(?!Story Points|Acceptance|Test Case)[^\n]+)*)', story_section, re.DOTALL | re.IGNORECASE)
            if story_desc_match:
                story_data["story_description"] = story_desc_match.group(1).strip()

            # Extract Story Points
            points_match = re.search(r'Story Points:\s*(\d+)', story_section, re.IGNORECASE)
            if points_match:
                story_data["story_points"] = points_match.group(1)

            # Extract Acceptance Criteria
            ac_match = re.search(r'Acceptance Criteria:\s*([^\n]+(?:\n(?!Test Case|User Story|Epic)[^\n]+)*)', story_section, re.DOTALL | re.IGNORECASE)
            if ac_match:
                story_data["acceptance_criteria"] = ac_match.group(1).strip()

            # Find all test cases for this user story
            test_sections = re.findall(r'Test Case ID:\s*(E\d+-US\d+-TC\d+)\s*Test Case Description:\s*([^\n]+).*?Expected Result:\s*(.+?)(?=Test Case ID:|User Story|Epic E\d+|$)', story_section, re.DOTALL | re.IGNORECASE)

            for tc_match in test_sections:
                test_data = {
                    "test_case_id": tc_match[0],
                    "test_case_description": tc_match[1].strip(),
                    "input_preconditions": "",
                    "input_test_data": "",
                    "input_user_action": "",
                    "expected_results": []
                }

                # Extract Input section fields from the full test case text
                # Find the text between Test Case Description and Expected Result
                tc_full = re.search(
                    r'Test Case ID:\s*' + re.escape(tc_match[0]) + r'.*?Expected Result',
                    story_section, re.DOTALL | re.IGNORECASE
                )
                if tc_full:
                    tc_text = tc_full.group(0)
                    pre_match = re.search(r'Preconditions?:\s*([^\n]+(?:\n(?!\s*-\s*(?:Test Data|User Action|Input)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
                    if pre_match:
                        test_data["input_preconditions"] = pre_match.group(1).strip()
                    td_match = re.search(r'Test Data:\s*([^\n]+(?:\n(?!\s*-\s*(?:User Action|Precondition)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
                    if td_match:
                        test_data["input_test_data"] = td_match.group(1).strip()
                    ua_match = re.search(r'User Action:\s*([^\n]+(?:\n(?!\s*-\s*(?:Precondition|Test Data)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
                    if ua_match:
                        test_data["input_user_action"] = ua_match.group(1).strip()

                # Parse expected results
                expected_text = tc_match[2].strip()
                numbered_items = re.findall(r'(\d+)\.\s*([^\n]+(?:\n(?!\d+\.)[^\n]+)*)', expected_text)
                test_data["expected_results"] = [item[1].strip() for item in numbered_items]

                story_data["test_cases"].append(test_data)

            epic_data["user_stories"].append(story_data)

        result["epics"].append(epic_data)

    return result


@app.route('/api/generate', methods=['POST'])
def generate():
    """API endpoint to generate epics from a project description using Gemini API."""
    try:
        data = request.get_json()
        description = data.get('description', '').strip()

        length_error = check_description(description)
        if length_error:
            return jsonify({'success': False, 'error': length_error}), 400

        gen = generator_for_request()
        if not gen:
            return jsonify({
                'success': False,
                'error': 'Gemini API not available'
            }), 503

        print(f"\n[API] Using Gemini API for generation...")
        sys.stdout.flush()

        gen_result = gen.generate_quick_summary(description)

        if not gen_result.get("success"):
            print(f"[API] [ERROR] Gemini API generation failed: {gen_result.get('error')}")
            sys.stdout.flush()
            return jsonify({
                'success': False,
                'error': 'Gemini API generation failed. Check server logs.'
            }), 500

        formatted_output = gen_result["raw_output"]
        print(f"[API] [SUCCESS] Gemini API generation successful")
        sys.stdout.flush()

        result = parse_multiple_epics(formatted_output)

        # Return results with formatted output
        return jsonify({
            'success': True,
            'result': result,
            'raw_output': formatted_output,
            'generator_used': 'Gemini API'
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': 'Generation service error'
        }), 500


@app.route('/api/examples', methods=['GET'])
def get_examples():
    """Get example project descriptions"""
    examples = [
        "Build a real-time chat application with user authentication and message history",
        "Create a mobile app for restaurant reservations with real-time availability",
        "Develop an e-commerce platform with product catalog, shopping cart, and checkout",
        "Build a task management system with teams, projects, and deadlines",
        "Create a dashboard for sales analytics with charts and reports",
        "Implement user authentication with OAuth and social login",
        "Add real-time notifications to the mobile app",
        "Build a REST API for customer data management",
        "Create a payment processing system with Stripe integration",
        "Develop a content management system with role-based permissions"
    ]

    return jsonify({
        'success': True,
        'examples': examples
    })


@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        'success': True,
        'status': 'running',
        'generators': {
            'gemini_api': {
                'available': gemini_generator is not None,
                'model': 'Gemini 2.5 Flash',
                'status': 'Primary Generator' if gemini_generator else 'Unavailable'
            }
        },
        'primary_generator': 'Gemini API' if gemini_generator else 'None'
    })


@app.route('/api/regenerate', methods=['POST'])
def regenerate():
    """
    API endpoint to regenerate a specific component of an epic.

    Request JSON:
    {
        "type": "epic" | "story" | "acceptance_criteria" | "test_case",
        "project_description": "Original project description",
        "context": {
            "epic_title": "...",
            "epic_description": "...",
            "story_title": "...",
            "story_description": "...",
            "story_id": "E1-US1",
            "epic_id": "E1"
        }
    }
    """
    try:
        data = request.get_json()
        regen_type = data.get('type', '').strip()
        project_description = data.get('project_description', '').strip()
        context = data.get('context', {})

        if not regen_type or not project_description:
            return jsonify({
                'success': False,
                'error': 'Missing type or project_description'
            }), 400

        length_error = check_description(project_description)
        if length_error:
            return jsonify({'success': False, 'error': length_error}), 400

        gen = generator_for_request()
        if not gen:
            return jsonify({
                'success': False,
                'error': 'Gemini API not available'
            }), 503

        prompt = _build_regenerate_prompt(regen_type, project_description, context)

        user_requirements = context.get('user_requirements', '')
        print(f"\n{'='*60}")
        print(f"[API] Regenerating {regen_type}...")
        print(f"[API] User requirements: '{user_requirements}'" if user_requirements else "[API] User requirements: (none)")
        print(f"[API] Prompt length: {len(prompt)} chars")
        print(f"[API] Prompt ends with: ...{prompt[-200:]}")
        print(f"{'='*60}")
        sys.stdout.flush()

        response = gen.client.models.generate_content(
            model=gen.model_name,
            contents=prompt
        )
        raw_text = response.text

        print(f"[API] [SUCCESS] Regeneration complete for {regen_type}")
        print(f"[API] Raw output preview: {raw_text[:300]}")
        sys.stdout.flush()

        # Parse the regenerated content based on type
        if regen_type == 'epic':
            result = parse_multiple_epics(raw_text)
            if result['epics']:
                return jsonify({
                    'success': True,
                    'type': 'epic',
                    'data': result['epics'][0]
                })
            else:
                return jsonify({
                    'success': False,
                    'error': 'Failed to parse regenerated epic'
                }), 500

        elif regen_type == 'story':
            result = _parse_single_story(raw_text, context.get('epic_id', 'E1'))
            return jsonify({
                'success': True,
                'type': 'story',
                'data': result
            })

        elif regen_type == 'acceptance_criteria':
            ac_text = _parse_acceptance_criteria(raw_text)
            return jsonify({
                'success': True,
                'type': 'acceptance_criteria',
                'data': ac_text
            })

        elif regen_type == 'test_case':
            tc_data = _parse_single_test_case(raw_text, context.get('story_id', 'E1-US1'))
            return jsonify({
                'success': True,
                'type': 'test_case',
                'data': tc_data
            })

        else:
            return jsonify({
                'success': False,
                'error': f'Unknown regeneration type: {regen_type}'
            }), 400

    except Exception as e:
        log.error(f"Regeneration failed: {e}")
        sys.stdout.flush()
        return jsonify({
            'success': False,
            'error': 'Regeneration service error'
        }), 500


def _build_regenerate_prompt(regen_type: str, project_description: str, context: dict) -> str:
    """Build a targeted prompt for regenerating a specific component."""
    epic_title = context.get('epic_title', '')
    epic_description = context.get('epic_description', '')
    story_title = context.get('story_title', '')
    story_description = context.get('story_description', '')
    story_id = context.get('story_id', 'E1-US1')
    epic_id = context.get('epic_id', 'E1')
    user_requirements = context.get('user_requirements', '')

    # Build user requirements section - placed at END of prompt for maximum LLM attention
    user_req_section = ''
    if user_requirements.strip():
        user_req_section = f"""

CRITICAL - USER'S SPECIFIC REQUIREMENTS (HIGHEST PRIORITY):
The user has provided these specific instructions for this regeneration:
"{user_requirements}"

You MUST tailor the generated content to match these requirements. These instructions override any generic defaults above. Make sure every part of your output directly reflects what the user asked for."""

    if regen_type == 'epic':
        return f"""You are a senior software architect. Regenerate a DIFFERENT version of this epic for the following project.
Generate a fresh take with different user stories, acceptance criteria, and test cases.
IMPORTANT: Output ONLY plain text. Do NOT use any markdown formatting (no **, no #, no `, no ---).
IMPORTANT: Include MEASURABLE METRICS in acceptance criteria and expected results (e.g., "within 2 seconds", "at least 99.5%", "every 500ms").

PROJECT DESCRIPTION:
{project_description}

The epic should cover this feature area: {epic_title}
Previous description was: {epic_description}

Generate a COMPLETELY NEW version with different details. Use Epic ID {epic_id}.
Each epic must have 2 user stories. Follow this EXACT plain text format:

Epic {epic_id}: [New Specific Title]
Description: As a [role], I want [capability] so that [benefit]

User Story {epic_id}-US1: [Feature Title]
Description: As a [role], I want [feature] so that [benefit]
Story Points: [1-13]
Acceptance Criteria: Given [specific precondition with measurable context], When [specific user action], Then [specific outcome with measurable metrics]

Test Case ID: {epic_id}-US1-TC1
Test Case Description: Verify that [specific functionality] works as specified
Input:
  - Preconditions: [Specific system state required before testing]
  - Test Data: [Concrete data examples with actual values]
  - User Action: [Step-by-step action the tester performs]
Expected Result:
1. [Specific outcome with measurable metric]
2. [Specific validation with expected values]
3. [Specific UI behavior with timing/display details]
4. [Specific data persistence verification]

User Story {epic_id}-US2: [Feature Title]
Description: As a [role], I want [feature] so that [benefit]
Story Points: [1-13]
Acceptance Criteria: Given [specific precondition with measurable context], When [specific user action], Then [specific outcome with measurable metrics]

Test Case ID: {epic_id}-US2-TC1
Test Case Description: Verify that [specific functionality] works as specified
Input:
  - Preconditions: [Specific system state required before testing]
  - Test Data: [Concrete data examples with actual values]
  - User Action: [Step-by-step action the tester performs]
Expected Result:
1. [Specific outcome with measurable metric]
2. [Specific validation with expected values]
3. [Specific UI behavior with timing/display details]
4. [Specific data persistence verification]{user_req_section}"""

    elif regen_type == 'story':
        return f"""You are a senior software architect. Generate a NEW user story for the following project and epic.
IMPORTANT: Output ONLY plain text. Do NOT use any markdown formatting (no **, no #, no `, no ---).
IMPORTANT: Include MEASURABLE METRICS in acceptance criteria and expected results (e.g., "within 2 seconds", "at least 99.5%", "every 500ms").

PROJECT DESCRIPTION:
{project_description}

EPIC: {epic_title}
EPIC DESCRIPTION: {epic_description}

Previous story was: {story_title} - {story_description}

Generate a COMPLETELY DIFFERENT user story. Use Story ID {story_id}. Follow this EXACT plain text format:

User Story {story_id}: [New Specific Feature Title]
Description: As a [specific role], I want [specific feature] so that [specific benefit]
Story Points: [1-13]
Acceptance Criteria: Given [specific precondition with measurable context], When [specific user action], Then [specific outcome with measurable metrics]

Test Case ID: {story_id}-TC1
Test Case Description: Verify that [specific functionality] works as specified
Input:
  - Preconditions: [Specific system state required before testing]
  - Test Data: [Concrete data examples with actual values]
  - User Action: [Step-by-step action the tester performs]
Expected Result:
1. [Specific outcome with measurable metric]
2. [Specific validation with expected values]
3. [Specific UI behavior with timing/display details]
4. [Specific data persistence verification]{user_req_section}"""

    elif regen_type == 'acceptance_criteria':
        return f"""You are a senior software architect. Generate exactly 3 NEW acceptance criteria for this user story.
IMPORTANT: Output ONLY plain text. Do NOT use any markdown formatting (no **, no #, no `, no ---).
IMPORTANT: Generate EXACTLY 3 acceptance criteria. No more, no less. Do NOT repeat or duplicate criteria.
IMPORTANT: Include MEASURABLE METRICS in each criterion (e.g., "within 2 seconds", "accuracy of 99.5%", "every 500 milliseconds", "within 3 meters").

PROJECT DESCRIPTION:
{project_description}

EPIC: {epic_title}
USER STORY: {story_title}
STORY DESCRIPTION: {story_description}

Generate 3 DIFFERENT, SPECIFIC acceptance criteria using Given/When/Then format.
Each criterion must cover a DIFFERENT aspect of the story. Do NOT repeat similar scenarios.
Each criterion MUST include at least one measurable metric (time, percentage, distance, count, etc.).
Return ONLY the 3 criteria, nothing else. No headers, no labels, no numbering prefix.

Format each criterion exactly like this (one blank line between each):

Given [specific precondition with measurable context], When [specific user action], Then [specific expected outcome with measurable metric]

Given [different precondition with measurable context], When [different action], Then [different outcome with measurable metric]

Given [another precondition with measurable context], When [another action], Then [another outcome with measurable metric]{user_req_section}"""

    elif regen_type == 'test_case':
        tc_id = context.get('test_case_id', f'{story_id}-TC1')
        tc_description = context.get('test_case_description', '')

        return f"""You are a senior QA engineer. Generate a NEW test case for this user story.
IMPORTANT: Output ONLY plain text. Do NOT use any markdown formatting (no **, no #, no `, no ---).
IMPORTANT: Include MEASURABLE METRICS in expected results (e.g., "within 2 seconds", "at least 99.5%", "displays 320 kcal").

PROJECT DESCRIPTION:
{project_description}

EPIC: {epic_title}
USER STORY: {story_title}
STORY DESCRIPTION: {story_description}

Previous test case was: {tc_description}

Generate a COMPLETELY DIFFERENT test case. Use Test Case ID {tc_id}. Follow this EXACT format:

Test Case ID: {tc_id}
Test Case Description: Verify that [specific functionality from the user story] works as specified
Input:
  - Preconditions: [Specific system state and requirements that must be met before testing]
  - Test Data: [Concrete data examples with actual values relevant to the feature]
  - User Action: [Step-by-step action the tester performs]
Expected Result:
1. [Specific outcome with measurable metric]
2. [Specific validation with expected values]
3. [Specific UI behavior with timing/display details]
4. [Specific data persistence verification]{user_req_section}"""

    return ""


def _parse_single_story(text: str, _epic_id: str) -> dict:
    """Parse a single regenerated user story from text."""
    import re

    text = _strip_markdown(text)

    story_data = {
        "story_id": "",
        "story_title": "",
        "story_description": "",
        "story_points": "",
        "acceptance_criteria": "",
        "test_cases": []
    }

    story_match = re.search(r'User Story\s+(E\d+-US\d+):\s*([^\n]+)', text, re.IGNORECASE)
    if story_match:
        story_data["story_id"] = story_match.group(1)
        story_data["story_title"] = story_match.group(2).strip()

    story_desc_match = re.search(r'User Story.*?Description:\s*([^\n]+(?:\n(?!Story Points|Acceptance|Test Case)[^\n]+)*)', text, re.DOTALL | re.IGNORECASE)
    if story_desc_match:
        story_data["story_description"] = story_desc_match.group(1).strip()

    points_match = re.search(r'Story Points:\s*(\d+)', text, re.IGNORECASE)
    if points_match:
        story_data["story_points"] = points_match.group(1)

    ac_match = re.search(r'Acceptance Criteria:\s*([^\n]+(?:\n(?!Test Case|User Story|Epic)[^\n]+)*)', text, re.DOTALL | re.IGNORECASE)
    if ac_match:
        story_data["acceptance_criteria"] = ac_match.group(1).strip()

    test_sections = re.findall(
        r'Test Case ID:\s*(E\d+-US\d+-TC\d+)\s*Test Case Description:\s*([^\n]+).*?Expected Result:\s*(.+?)(?=Test Case ID:|User Story|Epic E\d+|$)',
        text, re.DOTALL | re.IGNORECASE
    )
    for tc_match in test_sections:
        test_data = {
            "test_case_id": tc_match[0],
            "test_case_description": tc_match[1].strip(),
            "input_preconditions": "",
            "input_test_data": "",
            "input_user_action": "",
            "expected_results": []
        }
        # Extract Input section fields
        tc_full = re.search(
            r'Test Case ID:\s*' + re.escape(tc_match[0]) + r'.*?Expected Result',
            text, re.DOTALL | re.IGNORECASE
        )
        if tc_full:
            tc_text = tc_full.group(0)
            pre_m = re.search(r'Preconditions?:\s*([^\n]+(?:\n(?!\s*-\s*(?:Test Data|User Action|Input)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
            if pre_m:
                test_data["input_preconditions"] = pre_m.group(1).strip()
            td_m = re.search(r'Test Data:\s*([^\n]+(?:\n(?!\s*-\s*(?:User Action|Precondition)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
            if td_m:
                test_data["input_test_data"] = td_m.group(1).strip()
            ua_m = re.search(r'User Action:\s*([^\n]+(?:\n(?!\s*-\s*(?:Precondition|Test Data)|Expected)[^\n]+)*)', tc_text, re.IGNORECASE)
            if ua_m:
                test_data["input_user_action"] = ua_m.group(1).strip()

        expected_text = tc_match[2].strip()
        numbered_items = re.findall(r'(\d+)\.\s*([^\n]+(?:\n(?!\d+\.)[^\n]+)*)', expected_text)
        test_data["expected_results"] = [item[1].strip() for item in numbered_items]
        story_data["test_cases"].append(test_data)

    return story_data


def _parse_acceptance_criteria(text: str) -> str:
    """Parse regenerated acceptance criteria from text. Limits to first 5 Given/When/Then blocks."""
    import re

    text = _strip_markdown(text)

    # Strip any leading label the LLM may have added
    ac_match = re.search(r'Acceptance Criteria:\s*(.+)', text, re.DOTALL | re.IGNORECASE)
    if ac_match:
        text = ac_match.group(1).strip()

    # Extract individual Given/When/Then blocks (up to 5) to prevent repetition
    blocks = re.findall(
        r'(Given\s.+?Then\s[^\n]+(?:\n(?!Given\s)[^\n]+)*)',
        text, re.DOTALL | re.IGNORECASE
    )

    if blocks:
        # Deduplicate: keep only blocks with unique first 60 chars
        seen = set()
        unique = []
        for b in blocks:
            key = b.strip()[:60].lower()
            if key not in seen:
                seen.add(key)
                unique.append(b.strip())
        return '\n\n'.join(unique[:5])

    # Fallback: return the raw text but cap at ~2000 chars to prevent bloat
    return text.strip()[:2000]


def _parse_single_test_case(text: str, story_id: str) -> dict:
    """Parse a single regenerated test case from text."""
    import re

    text = _strip_markdown(text)

    tc_data = {
        "test_case_id": "",
        "test_case_description": "",
        "input_preconditions": "",
        "input_test_data": "",
        "input_user_action": "",
        "expected_results": []
    }

    tc_id_match = re.search(r'Test Case ID:\s*(E\d+-US\d+-TC\d+)', text, re.IGNORECASE)
    if tc_id_match:
        tc_data["test_case_id"] = tc_id_match.group(1)
    else:
        tc_data["test_case_id"] = f"{story_id}-TC1"

    tc_desc_match = re.search(r'Test Case Description:\s*([^\n]+)', text, re.IGNORECASE)
    if tc_desc_match:
        tc_data["test_case_description"] = tc_desc_match.group(1).strip()

    # Parse Input section
    pre_match = re.search(r'Preconditions?:\s*([^\n]+(?:\n(?!\s*-\s*(?:Test Data|User Action|Input)|Expected)[^\n]+)*)', text, re.IGNORECASE)
    if pre_match:
        tc_data["input_preconditions"] = pre_match.group(1).strip()
    td_match = re.search(r'Test Data:\s*([^\n]+(?:\n(?!\s*-\s*(?:User Action|Precondition)|Expected)[^\n]+)*)', text, re.IGNORECASE)
    if td_match:
        tc_data["input_test_data"] = td_match.group(1).strip()
    ua_match = re.search(r'User Action:\s*([^\n]+(?:\n(?!\s*-\s*(?:Precondition|Test Data)|Expected)[^\n]+)*)', text, re.IGNORECASE)
    if ua_match:
        tc_data["input_user_action"] = ua_match.group(1).strip()

    expected_section = re.search(r'Expected Result(?:s)?:\s*(.+?)(?=Test Case ID:|$)', text, re.DOTALL | re.IGNORECASE)
    if expected_section:
        expected_text = expected_section.group(1).strip()
        numbered_items = re.findall(r'(\d+)\.\s*([^\n]+(?:\n(?!\d+\.)[^\n]+)*)', expected_text)
        tc_data["expected_results"] = [item[1].strip() for item in numbered_items]

    return tc_data


@app.route('/api/classify', methods=['POST'])
def classify_epic():
    """
    API endpoint to classify an epic type using Gemini API

    Request JSON:
    {
        "epic_title": "Epic title here",
        "epic_description": "Epic description here"
    }

    Response JSON:
    {
        "success": true,
        "category": "Frontend Development"
    }
    """
    try:
        data = request.get_json()
        epic_title = data.get('epic_title', '').strip()
        epic_description = data.get('epic_description', '').strip()

        if not epic_title and not epic_description:
            return jsonify({
                'success': False,
                'error': 'Please provide epic_title or epic_description'
            }), 400

        gen = generator_for_request()
        if not gen:
            return jsonify({
                'success': False,
                'error': 'Gemini API not available'
            }), 503

        # Use Gemini to classify the epic
        classification_prompt = f"""Classify this epic into ONE of these categories:
- Mobile Development
- Frontend Development
- Backend Development
- DevOps/Infrastructure
- Data Science/ML
- Database/SQL
- Game Development
- Full Stack

Epic Title: {epic_title}
Epic Description: {epic_description}

Return ONLY the category name, nothing else."""

        try:
            # Use the gemini generator's internal method
            response = gen.client.models.generate_content(
                model=gen.model_name,
                contents=classification_prompt
            )
            category = response.text.strip()

            # Validate the category
            valid_categories = [
                "Mobile Development", "Frontend Development", "Backend Development",
                "DevOps/Infrastructure", "Data Science/ML", "Database/SQL",
                "Game Development", "Full Stack"
            ]

            if category not in valid_categories:
                # Default to Full Stack if classification is unclear
                category = "Full Stack"

            return jsonify({
                'success': True,
                'category': category
            })

        except Exception as e:
            log.error(f"Gemini classification failed: {e}")
            sys.stdout.flush()
            return jsonify({
                'success': False,
                'error': 'Classification failed'
            }), 500

    except Exception as e:
        log.error(f"Classification failed: {e}")
        sys.stdout.flush()
        return jsonify({
            'success': False,
            'error': 'Classification service error'
        }), 500


if __name__ == '__main__':
    # Production defaults: debug OFF, bind loopback only. Override via env.
    # Enabling debug exposes the Werkzeug console (an RCE risk); never default it on.
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))

    print("\n" + "="*80)
    print("EPIC/STORY GENERATOR WEB APP")
    print("="*80)
    print(f"\nDev server: http://{host}:{port}  (debug={debug})")
    print("For production, run behind a real WSGI server, e.g.:")
    print(f"  waitress-serve --host={host} --port={port} --threads=8 --channel-timeout=300 web_app:app")
    print("Press Ctrl+C to stop the server")
    print("\n" + "="*80 + "\n")

    app.run(debug=debug, host=host, port=port, use_reloader=debug)
