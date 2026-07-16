import fetch from 'node-fetch';
import { detectExpertise } from '../utils/expertiseDetector.js';
import { calculateExperienceLevel } from '../utils/experienceCalculator.js';

const GITHUB_API_BASE = 'https://api.github.com';

// Per-org GitHub client factory (Phase 2, step 2.6).
//
// The token is no longer read from env — each org connects its own PAT via the
// Settings UI (stored encrypted in org_integrations). Obtain a client with
//   const gh = await githubClientFor(orgId)   // services/githubClientFor.js
// A token is REQUIRED: unauthenticated GitHub allows only 60 req/hr, which a
// single developer analysis exhausts immediately.

/**
 * Create a GitHub client bound to one organization's token.
 * @param {string} token - GitHub PAT (repo read scope)
 */
export function createGithubClient(token) {
  if (!token) throw new Error('createGithubClient requires a token');

  const headers = { Authorization: `Bearer ${token}` };

  /**
   * Analyze a developer's GitHub commits
   * @param {string} username - GitHub username
   * @param {string} owner - Repository owner (optional, defaults to username)
   * @param {string} repo - Repository name (optional, if not provided analyzes top repos)
   * @returns {Promise<Object>} Analysis results with expertise and experience level
   */
  async function analyzeDeveloper(username, owner, repo) {
    try {
      owner = owner || username;

      let commits = [];
      let reposAnalyzed = [];
      let isMultiRepo = false;

      if (repo) {
        // Single repo mode
        commits = await fetchRepoCommits(owner, repo, username);
        reposAnalyzed = [repo];
      } else {
        // Multi-repo mode - analyze top repos
        const repos = await fetchUserRepos(username);
        const topRepos = repos.slice(0, 10); // Top 10 most recently pushed repos
        isMultiRepo = true;

        for (const r of topRepos) {
          try {
            const repoCommits = await fetchRepoCommits(r.owner.login, r.name, username, 30);
            commits = commits.concat(repoCommits.map(c => ({ ...c, repoName: r.name, repoOwner: r.owner.login })));
            if (repoCommits.length > 0) {
              reposAnalyzed.push(r.name);
            }
          } catch (error) {
            console.error(`Error fetching commits from ${r.name}: ${error.message}`);
          }
        }
      }

      if (commits.length === 0) {
        throw new Error('No commits found for this user');
      }

      // Fetch detailed commit data
      const detailedCommits = [];
      const files = [];
      const fileTypeCounts = {};

      for (const commit of commits.slice(0, 200)) {
        try {
          const commitOwner = commit.repoOwner || owner;
          const commitRepo = commit.repoName || repo || reposAnalyzed[0];
          const details = await fetchCommitDetails(commitOwner, commitRepo, commit.sha);
          detailedCommits.push(details);

          // Collect files
          if (details.files) {
            details.files.forEach(file => {
              files.push(file);
              const ext = file.filename.match(/\.([^.]+)$/)?.[1] || 'other';
              fileTypeCounts[ext] = (fileTypeCounts[ext] || 0) + 1;
            });
          }

          // Small delay to avoid rate limiting
          if (detailedCommits.length % 10 === 0) {
            await sleep(100);
          }
        } catch (error) {
          console.error(`Error fetching commit details: ${error.message}`);
        }
      }

      // Calculate metrics
      const analysis = analyzeCommits(commits, detailedCommits, files, fileTypeCounts);

      return {
        username,
        owner,
        repo,
        reposAnalyzed,
        isMultiRepo,
        analysis,
        avatar: `https://github.com/${username}.png`
      };

    } catch (error) {
      console.error(`Error analyzing developer ${username}:`, error);
      throw error;
    }
  }

  async function fetchUserRepos(username) {
    const url = `${GITHUB_API_BASE}/users/${username}/repos?sort=pushed&per_page=20`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch repos for ${username}: ${response.statusText}`);
    }

    return await response.json();
  }

  async function fetchRepoCommits(owner, repo, author, maxCommits = 100) {
    const commits = [];
    let page = 1;

    while (commits.length < maxCommits) {
      const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?author=${author}&per_page=100&page=${page}`;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        if (response.status === 404) break;
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const pageCommits = await response.json();
      if (pageCommits.length === 0) break;

      commits.push(...pageCommits);
      page++;

      if (pageCommits.length < 100) break;
    }

    // Fallback: if no commits found with author filter and owner matches, try without filter
    if (commits.length === 0 && owner === author) {
      page = 1;
      while (commits.length < maxCommits) {
        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?per_page=100&page=${page}`;
        const response = await fetch(url, { headers });
        if (!response.ok) break;
        const pageCommits = await response.json();
        if (pageCommits.length === 0) break;
        commits.push(...pageCommits);
        page++;
        if (pageCommits.length < 100) break;
      }
    }

    return commits.slice(0, maxCommits);
  }

  async function fetchCommitDetails(owner, repo, sha) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${sha}`;
    const response = await fetch(url, { headers });

    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const resetTime = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.min(Math.max(0, resetTime - Date.now()) + 1000, 60000);
      console.warn(`[GitHub] Rate limited, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      const retry = await fetch(url, { headers });
      if (!retry.ok) throw new Error(`Failed to fetch commit details: ${retry.statusText}`);
      await checkRateLimit(retry);
      return await retry.json();
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch commit details: ${response.statusText}`);
    }

    await checkRateLimit(response);
    return await response.json();
  }

  return { analyzeDeveloper };
}

// ─── Credential-free helpers (shared by every client) ───────────────────────

async function checkRateLimit(response) {
  const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '999', 10);
  if (remaining <= 5) {
    const resetTime = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
    const waitMs = Math.max(0, resetTime - Date.now()) + 1000;
    const cappedWait = Math.min(waitMs, 60000);
    console.warn(`[GitHub] Rate limit low (${remaining} remaining), waiting ${Math.round(cappedWait / 1000)}s`);
    await sleep(cappedWait);
  } else if (remaining <= 20) {
    await sleep(500);
  }
}

function analyzeCommits(commits, detailedCommits, files, fileTypeCounts) {
  // Calculate metrics
  let onTimeCount = 0;
  let lateCount = 0;
  let messageQualityScore = 0;
  let totalLinesAdded = 0;
  let totalLinesDeleted = 0;

  const hourlyData = Array(24).fill(0);
  const weekdayData = Array(7).fill(0);
  const commitDates = [];
  const commitSizes = [];

  commits.forEach(commit => {
    const date = new Date(commit.commit.author.date);
    const hour = date.getHours();
    const weekday = date.getDay();
    commitDates.push(date);

    hourlyData[hour]++;
    weekdayData[weekday]++;

    // Work pattern (1am-12am is on-time, 12am-1am is late)
    if (hour >= 1 && hour <= 23) {
      onTimeCount++;
    } else {
      lateCount++;
    }

    // Message quality
    const message = commit.commit.message;
    if (message.length > 10) messageQualityScore += 10;
    if (message.length > 30) messageQualityScore += 25;
    if (/^(feat|fix|docs|style|refactor|test|chore):/.test(message)) messageQualityScore += 25;
    if (/#\d+/.test(message)) messageQualityScore += 25;
  });

  detailedCommits.forEach(commit => {
    if (commit.stats) {
      totalLinesAdded += commit.stats.additions;
      totalLinesDeleted += commit.stats.deletions;
      const commitSize = commit.stats.additions + commit.stats.deletions;
      commitSizes.push(commitSize);
    }
  });

  // Calculate consistency
  commitDates.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < commitDates.length; i++) {
    const days = (commitDates[i] - commitDates[i - 1]) / (1000 * 60 * 60 * 24);
    intervals.push(days);
  }
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0;
  const consistencyScore = Math.max(0, Math.min(100, 100 - avgInterval * 5));

  const onTimePercentage = commits.length > 0
    ? (onTimeCount / commits.length) * 100
    : 0;

  const avgMessageQuality = commits.length > 0
    ? messageQualityScore / commits.length
    : 0;

  // Detect expertise
  const fileTypes = Object.entries(fileTypeCounts).map(([name, value]) => ({
    name: `.${name}`,
    value
  }));
  const expertise = detectExpertise(files, fileTypes);

  // Calculate experience level
  const experienceLevel = calculateExperienceLevel(
    commits.length,
    onTimePercentage,
    avgMessageQuality,
    consistencyScore
  );

  // Calculate commit size distribution
  const sizeRanges = [
    { range: "0-50", count: 0 },
    { range: "51-100", count: 0 },
    { range: "101-200", count: 0 },
    { range: "201-500", count: 0 },
    { range: "500+", count: 0 },
  ];

  commitSizes.forEach((size) => {
    if (size <= 50) sizeRanges[0].count++;
    else if (size <= 100) sizeRanges[1].count++;
    else if (size <= 200) sizeRanges[2].count++;
    else if (size <= 500) sizeRanges[3].count++;
    else sizeRanges[4].count++;
  });

  // Calculate consistency timeline (days between commits)
  const sortedDates = commitDates.sort((a, b) => a - b);
  const consistencyTimeline = [];
  for (let i = 0; i < Math.min(sortedDates.length - 1, 30); i++) {
    const diffDays = (sortedDates[i + 1].getTime() - sortedDates[i].getTime()) / (1000 * 60 * 60 * 24);
    consistencyTimeline.push({
      commit: `#${i + 1}`,
      days: Number.isFinite(diffDays) ? Number(diffDays.toFixed(1)) : 0,
    });
  }

  return {
    totalCommits: commits.length,
    onTimeCount,
    lateCount,
    onTimePercentage: onTimePercentage.toFixed(1),
    messageQualityScore: avgMessageQuality.toFixed(1),
    consistencyScore: consistencyScore.toFixed(1),
    avgCommitSize: detailedCommits.length > 0
      ? Math.round((totalLinesAdded + totalLinesDeleted) / detailedCommits.length)
      : 0,
    totalLinesAdded,
    totalLinesDeleted,
    fileTypes: fileTypes.slice(0, 10),
    expertise,
    experienceLevel,
    hourlyData: hourlyData.map((commits, hour) => ({
      hour: `${hour}:00`,
      commits
    })),
    weekdayData: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
      day,
      commits: weekdayData[i]
    })),
    commitSizeDistribution: sizeRanges,
    consistencyTimeline: consistencyTimeline.length ? consistencyTimeline : [{ commit: "#1", days: 0 }]
  };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
