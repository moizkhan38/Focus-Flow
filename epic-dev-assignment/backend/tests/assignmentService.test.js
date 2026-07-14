// Regression tests for the story-level auto-assignment engine.
// Pure logic — no network. Epics carry pre-set classifications so
// classifyEpic() (and therefore Flask/Gemini) is never invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Point Flask at a dead port so any accidental classification attempt
// fails fast instead of hitting a live service.
process.env.FLASK_URL = 'http://127.0.0.1:9';

const { autoAssignStories, reassignStory } = await import('../services/assignmentService.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function backendSenior(username = 'alice') {
  return {
    username,
    avatar: `${username}.png`,
    analysis: {
      expertise: {
        primary: 'Backend Development',
        all: [
          { name: 'Backend Development', score: 40 },
          { name: 'Database/SQL', score: 10 },
        ],
      },
      experienceLevel: { level: 'Senior' },
    },
  };
}

function frontendJunior(username = 'bob') {
  return {
    username,
    avatar: `${username}.png`,
    analysis: {
      expertise: {
        primary: 'Frontend Development',
        all: [{ name: 'Frontend Development', score: 30 }],
      },
      experienceLevel: { level: 'Junior' },
    },
  };
}

function fullStackSenior(username = 'carol') {
  return {
    username,
    avatar: `${username}.png`,
    analysis: {
      expertise: {
        primary: 'Full Stack',
        all: [
          { name: 'Frontend Development', score: 20 },
          { name: 'Backend Development', score: 18 },
          { name: 'Database/SQL', score: 12 },
          { name: 'DevOps/Infrastructure', score: 8 },
          { name: 'Mobile Development', score: 5 },
        ],
      },
      experienceLevel: { level: 'Senior' },
    },
  };
}

function backendEpic(stories, id = 'E1') {
  return {
    epic_id: id,
    epic_title: 'REST API backend endpoints',
    classification: { primary: 'Backend Development', confidence: 'high', method: 'keyword' },
    user_stories: stories,
  };
}

const story = (id, points = 5, title = `Story ${id}`) => ({
  story_id: id,
  story_title: title,
  story_points: points,
});

// ── autoAssignStories ────────────────────────────────────────────────────────

test('backend expert beats frontend junior for a backend story (score 100 vs 30, high confidence)', async () => {
  const result = await autoAssignStories(
    [backendEpic([story('E1-US1', 5)])],
    [backendSenior(), frontendJunior()],
  );

  assert.equal(result.success, true);
  assert.equal(result.assignments.length, 1);

  const a = result.assignments[0];
  assert.equal(a.developer.username, 'alice');
  // 50 expertise (perfect normalized match) + 30 senior + 20 workload
  assert.equal(a.score, 100);
  assert.deepEqual(a.breakdown, { expertiseMatch: 50, experienceLevel: 30, workloadBalance: 20 });
  assert.equal(a.confidence, 'high');
  assert.equal(result.workloadDistribution.alice, 5);
  assert.equal(result.workloadDistribution.bob, 0);
});

test('equal developers alternate via workload rebalancing (2 stories each)', async () => {
  const twin = (u) => ({ ...backendSenior(u) });
  const result = await autoAssignStories(
    [backendEpic([story('S1'), story('S2'), story('S3'), story('S4')])],
    [twin('alice'), twin('bob')],
  );

  const byDev = result.assignments.reduce((m, a) => {
    m[a.developer.username] = (m[a.developer.username] || 0) + 1;
    return m;
  }, {});
  assert.deepEqual(byDev, { alice: 2, bob: 2 });
  // First story goes to 'alice' via username tie-break; second to 'bob' via workload
  assert.equal(result.assignments[0].developer.username, 'alice');
  assert.equal(result.assignments[1].developer.username, 'bob');
  assert.equal(result.workloadDistribution.alice, 10);
  assert.equal(result.workloadDistribution.bob, 10);
});

test('full-stack developer gets breadth-proportional partial credit (30 expertise pts)', async () => {
  const result = await autoAssignStories(
    [backendEpic([story('E1-US1')])],
    [fullStackSenior()],
  );
  const a = result.assignments[0];
  assert.equal(a.developer.username, 'carol');
  // Full Stack partial credit: min(30, (5 areas / 5) * 30) = 30... but note
  // carol's `all` DOES contain 'Backend Development' (score 18/20 max) →
  // direct match wins: round((18/20)*50) = 45. Pin the direct-match path.
  assert.equal(a.breakdown.expertiseMatch, 45);
  assert.equal(a.score, 45 + 30 + 20);
});

test('string story_points are parsed; missing story_points default to 5', async () => {
  const epic = backendEpic([
    { story_id: 'S1', story_title: 'typed points', story_points: '8' },
    { story_id: 'S2', story_title: 'no points' },
  ]);
  const result = await autoAssignStories([epic], [backendSenior()]);
  assert.equal(result.workloadDistribution.alice, 13); // 8 + 5
  assert.equal(result.assignments[0].story.story_points, 8);
  assert.equal(result.assignments[1].story.story_points, 5);
});

test('summary totals are internally consistent', async () => {
  const result = await autoAssignStories(
    [backendEpic([story('S1', 3), story('S2', 8), story('S3', 5)])],
    [backendSenior(), frontendJunior()],
  );
  const s = result.summary;
  assert.equal(s.totalEpics, 1);
  assert.equal(s.totalStories, 3);
  assert.equal(s.totalStoryPoints, 16);
  assert.equal(
    s.highConfidenceAssignments + s.mediumConfidenceAssignments + s.lowConfidenceAssignments,
    3,
  );
  const workloadSum = Object.values(result.workloadDistribution).reduce((a, b) => a + b, 0);
  assert.equal(workloadSum, 16);
});

test('deterministic: same input produces identical assignments', async () => {
  const input = () => [backendEpic([story('S1'), story('S2'), story('S3')])];
  const devs = () => [backendSenior(), frontendJunior(), fullStackSenior()];
  const r1 = await autoAssignStories(input(), devs());
  const r2 = await autoAssignStories(input(), devs());
  assert.deepEqual(
    r1.assignments.map((a) => [a.story.story_id, a.developer.username, a.score]),
    r2.assignments.map((a) => [a.story.story_id, a.developer.username, a.score]),
  );
});

// ── reassignStory ────────────────────────────────────────────────────────────

function existingAssignment() {
  return {
    epic: {
      epic_id: 'E1',
      epic_title: 'REST API backend endpoints',
      classification: { primary: 'Backend Development', confidence: 'high' },
    },
    story: { story_id: 'E1-US1', story_title: 'Login endpoint', story_points: 8 },
    developer: { username: 'alice', expertise: 'Backend Development', experienceLevel: 'Senior' },
    score: 100,
    confidence: 'high',
    breakdown: { expertiseMatch: 50, experienceLevel: 30, workloadBalance: 20 },
  };
}

test('reassignStory moves workload and recalculates score for a known developer', () => {
  const assignments = [existingAssignment()];
  const workloads = { alice: 8, bob: 0 };
  const result = reassignStory(assignments, 'E1-US1', 'bob', workloads, [
    backendSenior('alice'),
    frontendJunior('bob'),
  ]);

  assert.equal(result.success, true);
  assert.equal(workloads.alice, 0);
  assert.equal(workloads.bob, 8);
  assert.equal(result.assignments[0].developer.username, 'bob');
  // bob has no Backend expertise → plain 'manual', not 'manual-verified'
  assert.equal(result.assignments[0].confidence, 'manual');
});

test('reassignStory marks manual-verified when the new dev has matching expertise', () => {
  const assignments = [existingAssignment()];
  const workloads = { alice: 8, dave: 0 };
  const result = reassignStory(assignments, 'E1-US1', 'dave', workloads, [
    backendSenior('alice'),
    backendSenior('dave'),
  ]);
  assert.equal(result.assignments[0].confidence, 'manual-verified');
});

test('reassignStory throws for an unknown story id', () => {
  assert.throws(
    () => reassignStory([existingAssignment()], 'NOPE-1', 'bob', {}, []),
    /not found/,
  );
});
