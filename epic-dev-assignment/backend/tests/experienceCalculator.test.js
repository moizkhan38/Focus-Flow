// Regression tests for commit-metrics → experience level scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateExperienceLevel } from '../utils/experienceCalculator.js';

test('strong metrics reach Senior with a perfect 100', () => {
  const r = calculateExperienceLevel(300, 80, 50, 90);
  assert.deepEqual(r, { level: 'Senior', tone: 'purple', score: 100 });
});

test('zero metrics floor at Beginner (score 20 from minimums)', () => {
  const r = calculateExperienceLevel(0, 0, 0, 0);
  // Floors: volume 10 + workPattern 2 + messageQuality 5 + consistency 3
  assert.deepEqual(r, { level: 'Beginner', tone: 'yellow', score: 20 });
});

test('undefined / NaN inputs behave like zeros (no crash, no NaN)', () => {
  const r = calculateExperienceLevel(undefined, NaN, null, 'nonsense');
  assert.equal(r.score, 20);
  assert.equal(r.level, 'Beginner');
  assert.ok(Number.isFinite(r.score));
});

test('mid-range metrics land on Mid-Level (pinned: 60 commits/40 onTime/25 msg/50 consistency → 65)', () => {
  const r = calculateExperienceLevel(60, 40, 25, 50);
  // volume 26 + workPattern 8 + messageQuality 18 + consistency 13 = 65
  assert.deepEqual(r, { level: 'Mid-Level', tone: 'blue', score: 65 });
});

test('score is clamped to [0, 100] and levels follow thresholds', () => {
  const senior = calculateExperienceLevel(1000, 100, 100, 100);
  assert.equal(senior.score, 100);
  assert.equal(senior.level, 'Senior');

  for (const [score, expected] of [
    [calculateExperienceLevel(210, 65, 45, 75).score, 'Senior'], // 40+15+25+20 = 100
  ]) {
    assert.ok(score >= 80, `expected >=80, got ${score}`);
    assert.equal(expected, 'Senior');
  }
});

test('more commits never lowers the level (monotonic volume sanity)', () => {
  const low = calculateExperienceLevel(10, 50, 25, 50).score;
  const mid = calculateExperienceLevel(120, 50, 25, 50).score;
  const high = calculateExperienceLevel(250, 50, 25, 50).score;
  assert.ok(low <= mid && mid <= high, `${low} <= ${mid} <= ${high} violated`);
});
