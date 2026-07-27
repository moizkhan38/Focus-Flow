import test from 'node:test';
import assert from 'node:assert/strict';
import { toRepoName } from '../services/githubService.js';

// Project name -> GitHub repository name. GitHub accepts only [A-Za-z0-9._-],
// so this runs on every project ever created and a bad result either 422s the
// create or produces an unreadable repo name.

test('a normal project name becomes a readable slug', () => {
  assert.equal(toRepoName('E-Commerce Platform'), 'e-commerce-platform');
  assert.equal(toRepoName('Fitness Tracker'), 'fitness-tracker');
});

test('disallowed characters are replaced, not dropped', () => {
  // Dropping would give "focusflowv2" — replacing keeps the word boundaries.
  assert.equal(toRepoName('Focus Flow (v2)'), 'focus-flow-v2');
  assert.equal(toRepoName('Sales & Marketing'), 'sales-marketing');
  assert.equal(toRepoName('Team/Project: Alpha'), 'team-project-alpha');
});

test('runs of separators collapse and edges are trimmed', () => {
  assert.equal(toRepoName('  Hello   World  '), 'hello-world');
  assert.equal(toRepoName('--Weird--Name--'), 'weird-name');
  assert.equal(toRepoName('...dots...'), 'dots');
});

test('legal characters are preserved', () => {
  assert.equal(toRepoName('api.v2_client'), 'api.v2_client');
});

test('non-latin or symbol-only names return empty rather than an invalid repo name', () => {
  // The route turns '' into an actionable 400 instead of letting GitHub 422.
  assert.equal(toRepoName('!!!'), '');
  assert.equal(toRepoName('   '), '');
  assert.equal(toRepoName(''), '');
  assert.equal(toRepoName(null), '');
});

test('reserved names . and .. are rejected', () => {
  assert.equal(toRepoName('.'), '');
  assert.equal(toRepoName('..'), '');
});

test('names are capped at GitHub\'s 100-character limit', () => {
  const name = toRepoName('a'.repeat(250));
  assert.equal(name.length, 100);
});

test('the slug is stable — the same project name always maps to the same repo', () => {
  // Re-running the wizard must find the existing repo rather than creating a
  // second one, which only holds if this is deterministic.
  assert.equal(toRepoName('My Project'), toRepoName('My  Project'));
  assert.equal(toRepoName('My Project'), toRepoName('my project'));
});
