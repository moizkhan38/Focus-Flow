// Regression tests for the hybrid keyword classifier.
// FLASK_URL is pointed at a dead port BEFORE import so the Gemini tie-break
// path deterministically falls back to keywords (no network, no cost).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FLASK_URL = 'http://127.0.0.1:9';

const { classifyEpic, classifyEpics } = await import('../services/epicClassifier.js');

test('clear backend epic classifies via keywords with high confidence', async () => {
  const result = await classifyEpic({
    epic_title: 'REST API backend endpoints',
    epic_description: 'Server-side authentication and authorization endpoints',
  });
  assert.equal(result.primary, 'Backend Development');
  assert.equal(result.method, 'keyword');
  assert.equal(result.confidence, 'high');
  assert.ok(result.score >= 3);
});

test('clear mobile epic classifies as Mobile Development', async () => {
  const result = await classifyEpic({
    epic_title: 'Mobile app for iOS and Android',
    epic_description: 'Flutter smartphone application',
  });
  assert.equal(result.primary, 'Mobile Development');
  assert.equal(result.confidence, 'high');
});

test('no keyword match defaults to Full Stack / low / default', async () => {
  const result = await classifyEpic({
    epic_title: 'Improve team morale',
    epic_description: 'Organize offsites and snacks',
  });
  assert.deepEqual(result, { primary: 'Full Stack', confidence: 'low', method: 'default' });
});

test('keyword tie with Gemini unreachable falls back to first tied type, low confidence', async () => {
  // "api" → Backend (1), "dashboard" → Frontend (1). Tie → Gemini attempt →
  // connection refused (dead port) → keyword fallback in declaration order.
  const result = await classifyEpic({
    epic_title: 'api dashboard',
    epic_description: '',
  });
  assert.equal(result.method, 'keyword');
  assert.equal(result.confidence, 'low');
  assert.equal(result.primary, 'Frontend Development'); // declaration order: Frontend before Backend
  assert.deepEqual(result.alternatives, ['Backend Development']);
});

test('classifyEpics maps epic_ids onto classifications', async () => {
  const results = await classifyEpics([
    { epic_id: 'E1', epic_title: 'REST API backend service', epic_description: '' },
    { epic_id: 'E2', epic_title: 'database schema migration', epic_description: '' },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].epic_id, 'E1');
  assert.equal(results[0].classification.primary, 'Backend Development');
  assert.equal(results[1].epic_id, 'E2');
  assert.equal(results[1].classification.primary, 'Database/SQL');
});
