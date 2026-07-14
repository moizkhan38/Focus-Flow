// Keep these in sync with backend constants:
//   epic-dev-assignment/backend/routes/epics.js
//   epic-generator/web_app.py
export const MIN_DESCRIPTION_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MIN_MEANINGFUL_WORDS = 5;

const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+\S/gm;

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

// Words that signal a real product/object being described.
const PRODUCT_TERMS = new Set([
  'app','apps','application','applications','system','platform','website','site','sites',
  'dashboard','tool','tools','service','services','software','product','portal','marketplace',
  'store','shop','blog','forum','network','game','bot','chatbot','assistant',
  'mobile','web','desktop','cli','api','sdk',
  'extension','plugin','library','framework','engine','pipeline','generator',
  'tracker','manager','scheduler','planner','calculator','editor','viewer',
  'management','analytics','crm','cms','erp',
]);

// Verbs that signal intent to build/operate something.
const ACTION_VERBS = new Set([
  'build','create','develop','make','design','implement','launch','deploy',
  'generate','automate','integrate','manage','track','monitor','organize',
  'schedule','analyze','process','support','provide','enable',
]);

export function isMeaningfulDescription(text) {
  const value = (text || '').trim();
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(value))) {
    return { ok: false, reason: 'placeholder' };
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
  if (meaningful.size < MIN_MEANINGFUL_WORDS) {
    return { ok: false, reason: 'low_content', uniqueWords: meaningful.size };
  }
  if (!hasProduct && !hasAction) {
    return { ok: false, reason: 'no_product_or_action', uniqueWords: meaningful.size };
  }
  return { ok: true, reason: null, uniqueWords: meaningful.size };
}

export function validateDescription(text) {
  const value = (text || '').trim();
  if (value.length === 0) {
    return { ok: false, error: 'Please enter a project description' };
  }
  if (value.length < MIN_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description is too short — add at least ${MIN_DESCRIPTION_LENGTH - value.length} more character${MIN_DESCRIPTION_LENGTH - value.length === 1 ? '' : 's'}.`,
    };
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description is too long — please trim to ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    };
  }
  const meaning = isMeaningfulDescription(value);
  if (!meaning.ok) {
    return {
      ok: false,
      error: 'Please provide a meaningful description with real features — describe what to build (e.g. app, platform, system) and its main features.',
    };
  }
  return { ok: true, error: null };
}

export function countFeatures(text) {
  if (!text) return 0;
  const matches = text.match(NUMBERED_LINE_RE);
  return matches ? matches.length : 0;
}

// Mirrors _count_features() in epic-generator/src/gemini_generator.py
export function estimateEpicCount(text) {
  const features = countFeatures(text);
  if (features === 0) {
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    if (words < 30) return 3;
    if (words < 80) return 4;
    return 5;
  }
  if (features <= 4) return features;
  if (features <= 8) return Math.max(4, Math.min(6, features - 1));
  return Math.max(5, Math.min(8, Math.floor(features / 2) + 1));
}

export function getQualityHint(text) {
  const value = (text || '').trim();
  const len = value.length;
  if (len === 0) {
    return { tone: 'info', message: 'Describe your project to generate epics.' };
  }
  if (len < MIN_DESCRIPTION_LENGTH) {
    return { tone: 'warn', message: `Add ${MIN_DESCRIPTION_LENGTH - len} more character${MIN_DESCRIPTION_LENGTH - len === 1 ? '' : 's'} to enable Generate.` };
  }
  const meaning = isMeaningfulDescription(value);
  if (!meaning.ok) {
    if (meaning.reason === 'placeholder') {
      return { tone: 'warn', message: 'Looks like placeholder text — describe the actual project.' };
    }
    if (meaning.reason === 'no_product_or_action') {
      return { tone: 'warn', message: 'Mention what to build (app, platform, system…) and its real features.' };
    }
    return { tone: 'warn', message: `Only ${meaning.uniqueWords} meaningful word${meaning.uniqueWords === 1 ? '' : 's'} detected — add more detail.` };
  }
  if (len < 60) {
    return { tone: 'warn', message: 'Description is very short — more detail produces sharper epics.' };
  }
  const features = countFeatures(value);
  if (features === 0 && len < 150) {
    return { tone: 'info', message: 'Tip: list features as a numbered list (1. … 2. …) for clearer epics.' };
  }
  if (features >= 1) {
    return { tone: 'success', message: `Detected ${features} numbered feature${features === 1 ? '' : 's'}.` };
  }
  return { tone: 'success', message: 'Looks good — ready to generate.' };
}
