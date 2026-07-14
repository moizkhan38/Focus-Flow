// Regression tests for the shared description validator (frontend copy).
// Constants and rules are mirrored in backend/routes/epics.js and
// epic-generator/web_app.py — the smoke harness covers those via HTTP 400s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  validateDescription,
  isMeaningfulDescription,
  countFeatures,
  estimateEpicCount,
  getQualityHint,
} from '../src/utils/descriptionValidator.js';

const VALID_DESC =
  'Build a fitness tracking mobile application with workout logging, nutrition tracking, and progress analytics';

test('constants match the cross-layer contract (30 / 4000 / 5)', () => {
  assert.equal(MIN_DESCRIPTION_LENGTH, 30);
  assert.equal(MAX_DESCRIPTION_LENGTH, 4000);
});

test('empty description is rejected', () => {
  const r = validateDescription('');
  assert.equal(r.ok, false);
  assert.match(r.error, /enter a project description/i);
});

test('short description is rejected with remaining-character count', () => {
  const r = validateDescription('Build an app'); // 12 chars
  assert.equal(r.ok, false);
  assert.match(r.error, /18 more characters/);
});

test('over-long description is rejected', () => {
  const r = validateDescription('a'.repeat(MAX_DESCRIPTION_LENGTH + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/i);
});

test('placeholder text is rejected even when long enough', () => {
  const r = validateDescription('this is a placeholder description for the project');
  assert.equal(r.ok, false);
  assert.match(r.error, /meaningful description/i);
  assert.equal(isMeaningfulDescription('lorem ipsum dolor sit amet something here').ok, false);
});

test('gibberish with no product/action terms is rejected', () => {
  const r = validateDescription('asdfgh qwerty zxcvbn poiuyt lkjhgf mnbvcx');
  assert.equal(r.ok, false);
  const m = isMeaningfulDescription('asdfgh qwerty zxcvbn poiuyt lkjhgf mnbvcx');
  assert.equal(m.reason, 'no_product_or_action');
});

test('a real project description passes', () => {
  const r = validateDescription(VALID_DESC);
  assert.deepEqual(r, { ok: true, error: null });
});

test('countFeatures counts numbered lines only', () => {
  const text = 'Build a platform with:\n1. login\n2. dashboards\n3. exports\nnot a feature\n10) reports';
  assert.equal(countFeatures(text), 4);
  assert.equal(countFeatures('no numbers here'), 0);
  assert.equal(countFeatures(''), 0);
});

test('estimateEpicCount buckets: word-count fallback and feature scaling', () => {
  assert.equal(estimateEpicCount('short thing'), 3); // <30 words, 0 features
  const sixFeatures =
    'Build a task platform with features:\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f';
  assert.equal(estimateEpicCount(sixFeatures), 5); // max(4, min(6, 6-1))
  const three = 'Make an app:\n1. a\n2. b\n3. c';
  assert.equal(estimateEpicCount(three), 3); // <=4 → count as-is
});

test('getQualityHint tones: info → warn → numbered-list tip → success', () => {
  assert.equal(getQualityHint('').tone, 'info');
  assert.equal(getQualityHint('too short').tone, 'warn');
  // Valid but short-ish prose (<150 chars, no numbered list) → numbered-list tip
  const plain = getQualityHint(VALID_DESC);
  assert.equal(plain.tone, 'info');
  assert.match(plain.message, /numbered list/);
  const withFeatures = `${VALID_DESC}\n1. workout logging\n2. nutrition tracking`;
  const hint = getQualityHint(withFeatures);
  assert.equal(hint.tone, 'success');
  assert.match(hint.message, /2 numbered features/);
});
