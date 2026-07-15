"""
Gemini-based Epic/Story/Test Case Generator using Google Generative AI
Generates detailed outputs matching the format from the Autonomous Solar Vehicle proposal
"""

from google import genai
import os
from typing import Dict, List


class GeminiEpicGenerator:
    """
    Uses Google's Gemini API to generate comprehensive project documentation
    including epics, user stories, acceptance criteria, and test cases
    """

    def __init__(self, api_key: str = None):
        """
        Initialize the Gemini generator

        Args:
            api_key: Google API key (or set GEMINI_API_KEY environment variable)
        """
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "Google API key required. Set GEMINI_API_KEY environment variable "
                "or pass api_key parameter"
            )

        self.client = genai.Client(api_key=self.api_key)
        # 2.5-flash models are gated for newly-created API keys; the newest aliases
        # (flash-latest / 3.x) often 503 under load. gemini-2.0-flash is broadly
        # available and stable. Override with GEMINI_MODEL (e.g. gemini-flash-latest)
        # once the key has paid-tier quota.
        self.model_name = os.environ.get('GEMINI_MODEL', 'gemini-2.0-flash')

    def generate_comprehensive_documentation(
        self,
        project_description: str,
        num_epics: int = 3,
        num_stories_per_epic: int = 2,
        include_test_cases: bool = True
    ) -> Dict:
        """
        Generate complete project documentation from a description

        Args:
            project_description: High-level project description
            num_epics: Number of epics to generate (default: 3)
            num_stories_per_epic: User stories per epic (default: 2)
            include_test_cases: Whether to include detailed test cases

        Returns:
            Dictionary containing structured documentation
        """
        prompt = self._build_comprehensive_prompt(
            project_description,
            num_epics,
            num_stories_per_epic,
            include_test_cases
        )

        try:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=prompt
            )
            response_text = response.text

            return {
                "success": True,
                "project_description": project_description,
                "documentation": {"formatted_text": response_text, "format": "markdown"},
                "raw_output": response_text
            }

        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": str(e),
                "project_description": project_description
            }

    def _build_comprehensive_prompt(
        self,
        description: str,
        num_epics: int,
        num_stories_per_epic: int,
        include_test_cases: bool
    ) -> str:
        """Build the prompt for Gemini API - generates specific, detailed documentation"""

        prompt = f"""You are a senior software architect creating comprehensive, SPECIFIC project documentation following a structured engineering format.

CRITICAL INSTRUCTIONS:
- Read the ENTIRE project description carefully and ANALYZE all features mentioned
- Group related features into DISTINCT major feature areas (Epics)
- You should generate between 3 and 10 Epics depending on the project scope — DO NOT always generate the same number
- Each Epic must represent a DIFFERENT major system capability
- Each Epic should have between 1 and 5 User Stories depending on the complexity of that feature area:
  - Simple features (e.g., a settings page, a logout button): 1 story
  - Medium features (e.g., user profile, notifications): 2-3 stories
  - Complex features (e.g., real-time dashboard, payment processing, AI recommendations): 4-5 stories
- The total number of stories should be PROPORTIONAL to the project's complexity — a simple app might have 8-12 stories total, while a complex platform could have 20-35
- DO NOT always generate the same count of epics or stories — VARY them based on the actual description
- Generate SPECIFIC, DETAILED content based on the ACTUAL requirements provided
- DO NOT use generic placeholders or vague descriptions
- Every Epic, User Story, and Test Case must be directly relevant to the project description
- Include MEASURABLE METRICS in all acceptance criteria and expected results (e.g., "within 2 seconds", "at least 99.5%", "every 500 milliseconds", "within 3 meters")

ANALYSIS INSTRUCTIONS:
1. Identify the major feature categories from the project description — group small related features together rather than creating one epic per bullet point
2. Each Epic should cover a distinct functional area (e.g., Authentication, Dashboard, Data Entry, Analytics, etc.)
3. Number Epics sequentially: E1, E2, E3, E4, E5...
4. User Stories should be numbered per Epic: E1-US1, E1-US2, E2-US1, E2-US2, etc.
5. Test Cases should follow User Story IDs: E1-US1-TC1, E1-US2-TC1, E2-US1-TC1, etc.

PROJECT DESCRIPTION:
{description}

Analyze the description above and generate an APPROPRIATE number of Epics (between 3 and 10) with a VARYING number of User Stories per Epic (1-5 based on complexity).
Each User Story must have exactly 1 Test Case.
Output must follow this EXACT format (plain text, not markdown):

Epic E[number]: [Specific Title Based on Project Description]
Description: As a [specific stakeholder role], I want [specific high-level capability from project] so that [actual business value from requirements]

User Story E[epic#]-US[story#]: [Specific Feature Title]
Description: As a [specific user role], I want [exact feature from project description] so that [actual user benefit]
Story Points: [1-13 based on complexity]
Acceptance Criteria: Given [specific precondition with measurable context, e.g., "the user has an active session and GPS accuracy is within 2 meters"], When [specific user action from requirements], Then [specific expected outcome with measurable metrics, e.g., "the system updates the display within 200 milliseconds and logs the event with timestamp accuracy of 1 second"]

Test Case ID: E[epic#]-US[story#]-TC1
Test Case Description: Verify that [specific functionality from project description] works as specified
Input:
  - Preconditions: [Specific system state and requirements that must be met before testing, e.g., "System is powered on, user is authenticated, database connection is active"]
  - Test Data: [Concrete data examples relevant to the feature, e.g., "Username: testuser@example.com, Workout: Running, Duration: 30 min, Distance: 5km"]
  - User Action: [Specific step-by-step action the tester performs, e.g., "Navigate to workout log, select 'Running', enter duration and distance, tap 'Save'"]
Expected Result:
1. [Specific outcome with measurable metric - e.g., "Workout entry is saved to database within 2 seconds with all fields populated"]
2. [Specific validation - e.g., "Calorie calculation displays 320 kcal based on activity type, duration, and user weight"]
3. [Specific UI behavior - e.g., "Success toast notification appears for 3 seconds with message 'Workout logged successfully'"]
4. [Specific data persistence - e.g., "Workout history page shows the new entry with correct date, duration (30 min), and distance (5km)"]

EXAMPLE OF GOOD (SPECIFIC) vs BAD (GENERIC):
BAD: "Given a user is on the page, When they click submit, Then it works"
GOOD: "Given the user has entered valid GPS coordinates with accuracy within 2 meters and battery level is above 10%, When the user taps 'Start Tracking', Then the system begins recording position data every 500 milliseconds and displays real-time speed within 200ms latency"

BAD: "Preconditions: System is ready"
GOOD: "Preconditions: Vehicle control system is powered on with firmware v2.1+, GPS module has acquired satellite lock (minimum 4 satellites), obstacle detection sensors are calibrated within the last 24 hours"

Now generate the documentation using ONLY specific details from the project description above:"""

        return prompt

    def _count_features(self, description: str) -> int:
        """
        Analyze project description and estimate appropriate epic count.
        Groups related features together rather than 1:1 mapping.

        Args:
            description: Project description text

        Returns:
            Recommended number of epics (3-10)
        """
        import re

        # Count numbered features (1. 2. 3. etc.)
        numbered_pattern = r'(?:^|\n)\s*\d+\.\s+[A-Z]'
        numbered_features = len(re.findall(numbered_pattern, description, re.MULTILINE))

        # Count bullet points/dashes (- Feature or * Feature)
        bullet_pattern = r'(?:^|\n)\s*[-*]\s+[A-Z]'
        bullet_features = len(re.findall(bullet_pattern, description, re.MULTILINE))

        # Count "Core Features Required:" section items
        core_features_match = re.search(r'Core Features Required:(.+?)(?=\n\n|\Z)', description, re.DOTALL | re.IGNORECASE)
        core_features_count = 0
        if core_features_match:
            core_section = core_features_match.group(1)
            core_features_count = len(re.findall(r'\d+\.', core_section))

        # Use the highest count found
        feature_count = max(numbered_features, bullet_features, core_features_count)

        # Scale down: group related features into epics
        # Many listed features are sub-features that should be stories, not epics
        if feature_count == 0:
            # Short description with no structure — estimate from word count
            word_count = len(description.split())
            if word_count < 30:
                return 3
            elif word_count < 80:
                return 4
            else:
                return 5
        elif feature_count <= 4:
            return feature_count
        elif feature_count <= 8:
            # Group slightly: 5-8 features → 4-6 epics
            return max(4, min(6, feature_count - 1))
        else:
            # Many features: group into 5-8 epics, let stories handle detail
            return max(5, min(8, feature_count // 2 + 1))

    def generate_quick_summary(self, project_description: str) -> Dict:
        """
        Generate comprehensive documentation with multiple epics.
        Analyzes the description and breaks it into appropriate feature areas.
        Story count per epic varies based on feature complexity (1-5).

        Args:
            project_description: Project description

        Returns:
            Comprehensive documentation with varying epics and stories
        """
        # Dynamically determine approximate epic count based on features in description
        num_epics = self._count_features(project_description)

        return self.generate_comprehensive_documentation(
            project_description,
            num_epics=num_epics,
            num_stories_per_epic=0,  # 0 = let AI decide (1-5 per epic based on complexity)
            include_test_cases=True
        )

