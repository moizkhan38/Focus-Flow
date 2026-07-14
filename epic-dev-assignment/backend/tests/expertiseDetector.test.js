// Regression tests for file-pattern → expertise detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectExpertise } from '../utils/expertiseDetector.js';

test('frontend-heavy files detect Frontend Development', () => {
  const result = detectExpertise([
    'src/components/App.jsx',
    'src/components/Header.jsx',
    'styles/main.css',
  ]);
  assert.equal(result.primary, 'Frontend Development');
  assert.equal(result.primaryIcon, '🌐');
  assert.ok(result.technologies.includes('JSX'));
});

test('backend-heavy files detect Backend Development as top area', () => {
  const result = detectExpertise([
    'api/server.py',
    'api/routes.py',
    'controllers/user.go',
  ]);
  assert.equal(result.primary, 'Backend Development');
  assert.ok(result.all[0].score > 0);
});

test('3+ significant areas collapse to Full Stack', () => {
  const result = detectExpertise([
    'src/components/A.jsx', // Frontend: ext 2 + path 3 = 5
    'api/server.py',        // Backend: ext 2 + path 3 = 5
    'migrations/001.sql',   // Database: ext 2 + path 3 = 5
    'Dockerfile',           // DevOps: config 5
  ]);
  assert.equal(result.primary, 'Full Stack');
  assert.ok(result.all.length >= 3);
});

test('no matching files yields General Development', () => {
  const result = detectExpertise([]);
  assert.equal(result.primary, 'General Development');
  assert.deepEqual(result.all[0], {
    name: 'General Development', score: 0, icon: '💻', color: 'gray',
  });
});

test('fileTypes frequency weighting boosts matching areas', () => {
  const result = detectExpertise([], [{ name: '.py', value: 50 }]);
  // .py maps to both Backend and Data Science/ML; both get +50 and
  // declaration order puts Backend first on the stable sort.
  assert.equal(result.primary, 'Backend Development');
  const backend = result.all.find((a) => a.name === 'Backend Development');
  assert.equal(backend.score, 50);
});

test('accepts objects with a filename property (GitHub API shape)', () => {
  const result = detectExpertise([{ filename: 'src/components/Button.tsx' }]);
  assert.equal(result.primary, 'Frontend Development');
});
