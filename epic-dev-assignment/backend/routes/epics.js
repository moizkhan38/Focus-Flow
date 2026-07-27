import express from 'express';
import rateLimit from 'express-rate-limit';
import { generateEpics, regenerateComponent } from '../services/flaskProxy.js';
import { getGeminiKey } from '../services/credentialProvider.js';
import { classifyEpics } from '../services/epicClassifier.js';
import { sendServerError } from '../utils/httpError.js';
import { requireAiQuota } from '../middleware/requirePlan.js';
import { recordUsage, METRICS } from '../services/billing.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js.

// Keep in sync with frontend (frontend/src/utils/descriptionValidator.js)
// and Flask (epic-generator/web_app.py).
const MIN_DESCRIPTION_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 4000;
const MIN_MEANINGFUL_WORDS = 5;

const PLACEHOLDER_PATTERNS = [
  /\bno description\b/i,
  /\bnot available\b/i,
  /\bnot provided\b/i,
  /\blorem ipsum\b/i,
  /\bplaceholder\b/i,
  /^\s*(n\/a|na|tbd|none|nothing|test|asdf|qwerty|idk|hello world)\s*\.?\s*$/i,
];

const STOPWORDS = new Set([
  'a','an','the','and','or','of','to','in','on','at','by','for','with','as','from','into',
  'is','are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','can','could','should','may','might','must','that','this','these','those',
  'it','its','no','not','but','if','when','where','what','who','our','your','their','they','them',
]);

const PRODUCT_TERMS = new Set([
  'app','apps','application','applications','system','platform','website','site','sites',
  'dashboard','tool','tools','service','services','software','product','portal','marketplace',
  'store','shop','blog','forum','network','game','bot','chatbot','assistant',
  'mobile','web','desktop','cli','api','sdk',
  'extension','plugin','library','framework','engine','pipeline','generator',
  'tracker','manager','scheduler','planner','calculator','editor','viewer',
  'management','analytics','crm','cms','erp',
]);

const ACTION_VERBS = new Set([
  'build','create','develop','make','design','implement','launch','deploy',
  'generate','automate','integrate','manage','track','monitor','organize',
  'schedule','analyze','process','support','provide','enable',
]);

const MEANINGFUL_ERROR = 'Please provide a meaningful description with real features — describe what to build (e.g. app, platform, system) and its main features.';

function checkDescription(description) {
  const value = typeof description === 'string' ? description.trim() : '';
  if (value.length === 0) return 'Project description is required';
  if (value.length < MIN_DESCRIPTION_LENGTH) {
    return `Description is too short — minimum ${MIN_DESCRIPTION_LENGTH} characters.`;
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    return `Description is too long — maximum ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(value))) {
    return MEANINGFUL_ERROR;
  }
  const tokens = value.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const meaningful = new Set();
  let hasProduct = false;
  let hasAction = false;
  for (const t of tokens) {
    if (PRODUCT_TERMS.has(t)) hasProduct = true;
    if (ACTION_VERBS.has(t)) hasAction = true;
    if (t.length >= 4 && !STOPWORDS.has(t)) meaningful.add(t);
  }
  if (meaningful.size < MIN_MEANINGFUL_WORDS || (!hasProduct && !hasAction)) {
    return MEANINGFUL_ERROR;
  }
  return null;
}

// Rate limit for AI endpoints — protects Gemini quota from runaway loops or abuse.
// Generous enough for normal wizard use (generate + many regenerates).
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 60,                  // 60 AI calls per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many AI requests — please wait a moment before retrying.' },
});

// POST /api/generate - Generate epics from project description
router.post('/generate', aiLimiter, requireAiQuota, async (req, res) => {
  try {
    const { description } = req.body;

    const lengthError = checkDescription(description);
    if (lengthError) {
      return res.status(400).json({ success: false, error: lengthError });
    }

    // Optional per-org key; null means Flask falls back to the platform key (D5).
    const geminiKey = await getGeminiKey(req.orgId);
    const result = await generateEpics(description, geminiKey);

    res.json(result);
  } catch (error) {
    sendServerError(res, error, 'Failed to generate epics');
  }
});

// POST /api/regenerate - Regenerate a specific epic component
router.post('/regenerate', aiLimiter, requireAiQuota, async (req, res) => {
  try {
    const { type, project_description, context } = req.body;
    console.log(`[Regenerate] type=${type}, user_requirements="${context?.user_requirements || '(none)'}"`);

    if (!type || !project_description) {
      return res.status(400).json({
        success: false,
        error: 'type and project_description are required'
      });
    }

    const lengthError = checkDescription(project_description);
    if (lengthError) {
      return res.status(400).json({ success: false, error: lengthError });
    }

    const geminiKey = await getGeminiKey(req.orgId);
    const result = await regenerateComponent(type, project_description, context || {}, geminiKey);

    res.json(result);
  } catch (error) {
    sendServerError(res, error, 'Failed to regenerate component');
  }
});

// POST /api/classify-epics - Classify epic types
//
// aiLimiter applies here too. This fans out one Gemini call PER EPIC on the
// shared platform key (D5), so without a limit and a cap on the array, a single
// authenticated request could spend the platform's quota — and the bill — on
// behalf of every tenant.
const MAX_EPICS_PER_CLASSIFY = 50;

router.post('/classify-epics', aiLimiter, requireAiQuota, async (req, res) => {
  try {
    const { epics } = req.body;

    if (!epics || !Array.isArray(epics)) {
      return res.status(400).json({
        success: false,
        error: 'Epics array is required'
      });
    }

    if (epics.length > MAX_EPICS_PER_CLASSIFY) {
      return res.status(400).json({
        success: false,
        error: `Too many epics in one request (max ${MAX_EPICS_PER_CLASSIFY}).`
      });
    }

    const classifications = await classifyEpics(epics);

    res.json({
      success: true,
      classifications
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to classify epics');
  }
});

export default router;
