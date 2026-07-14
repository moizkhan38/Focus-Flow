// Regression tests for the Jira sprint health score
// (weights: burndown 40 / blockers 30 / bugs 20 / scope 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateHealthScore } from '../src/utils/healthScore.js';

test('no data at all → perfect 100 / healthy', () => {
  const r = calculateHealthScore(null, [], 0, 0);
  assert.equal(r.score, 100);
  assert.equal(r.level, 'healthy');
  assert.equal(r.factors.length, 4);
  assert.equal(r.factors[0].detail, 'No data yet');
});

test('burndown deviation subtracts proportionally (20% deviation → 92)', () => {
  const burndown = [
    { ideal: 50, actual: 50 },
    { ideal: 40, actual: 60 }, // +20 over ideal
  ];
  const r = calculateHealthScore(burndown, [], 100, 100);
  // burndownScore = 40 - 20*0.4 = 32 → 100 - 8 = 92
  assert.equal(r.score, 92);
  assert.equal(r.level, 'healthy');
  assert.equal(r.factors[0].detail, '20% deviation');
});

test('no burndown yet → issue completion rate proxy', () => {
  const issues = [
    { status: 'Done' },
    { status: 'In Progress' },
    { status: 'To Do' },
    { status: 'Closed' },
  ];
  const r = calculateHealthScore(null, issues, 20, 20);
  // 2/4 done → completion 50% → progress 30/40 → 100 - 10 = 90
  assert.equal(r.score, 90);
  assert.equal(r.factors[0].name, 'Progress');
  assert.match(r.factors[0].detail, /50% complete/);
});

test('blockers cost 10 each (cap 30) and push level to at-risk', () => {
  const issues = [
    { status: 'To Do', priority: 'Blocker' },
    { status: 'To Do', priority: 'Critical' },
  ];
  const r = calculateHealthScore(null, issues, 10, 10);
  // progress proxy: 0% done → 20/40 (−20); blockers: 30−20=10 (−20) → 60
  assert.equal(r.score, 60);
  assert.equal(r.level, 'at-risk');
  const blockerFactor = r.factors.find((f) => f.name === 'Blockers');
  assert.equal(blockerFactor.score, 10);
});

test('bugs cost 5 each (cap 20)', () => {
  const issues = [
    { status: 'Done', issueType: 'Bug' },
    { status: 'Done', issueType: 'bug' },
  ];
  const r = calculateHealthScore(null, issues, 10, 10);
  // progress: 100% done → 40/40 (−0); bugs: 20−10=10 (−10) → 90
  assert.equal(r.score, 90);
  const bugFactor = r.factors.find((f) => f.name === 'Bugs');
  assert.match(bugFactor.detail, /2 bugs/);
});

test('scope creep subtracts from the 10-point scope factor', () => {
  const r = calculateHealthScore(null, [], 130, 100);
  // +30% scope → scopeScore = 10 − 3 = 7 → 100 − 3 = 97
  assert.equal(r.score, 97);
  const scope = r.factors.find((f) => f.name === 'Scope');
  assert.equal(scope.detail, '+30% scope');
});

test('pile-up of problems reaches critical (<50)', () => {
  const issues = Array.from({ length: 5 }, () => ({
    status: 'To Do',
    priority: 'Blocker',
    issueType: 'Bug',
  }));
  const r = calculateHealthScore(null, issues, 10, 10);
  // progress 20/40 (−20) + blockers 0/30 (−30) + bugs 0/20 (−20) → 30
  assert.equal(r.score, 30);
  assert.equal(r.level, 'critical');
});

test('score is always clamped to [0, 100]', () => {
  const horrible = Array.from({ length: 50 }, () => ({
    status: 'To Do', priority: 'Blocker', issueType: 'Bug',
  }));
  const r = calculateHealthScore(null, horrible, 10, 1);
  assert.ok(r.score >= 0 && r.score <= 100);
});
