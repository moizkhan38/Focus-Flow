import express from 'express';
import { githubClientFor } from '../services/githubClientFor.js';
import { toRepoName } from '../services/githubService.js';
import { getGithubOwner } from '../services/credentialProvider.js';
import { sendUpstreamError } from '../utils/httpError.js';
import { query } from '../db.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js.
// GitHub credentials are per-org; orgs without a connected GitHub get
// 412 GITHUB_NOT_CONNECTED via sendUpstreamError.

// Collaborators may only be drawn from THIS org's developer roster.
//
// Same reasoning as the Jira invite guard in sync.js: this runs with the org's
// stored GitHub token, which carries write scope. Taking usernames straight from
// the request body would let any org member grant push access on the company's
// repositories to an arbitrary GitHub account. The caller can never read the
// token, but they could aim it.
const MAX_COLLABORATORS = 50;

async function rosterUsernames(orgId, requested) {
  const wanted = [...new Set(
    requested
      .filter((u) => typeof u === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(u.trim()))
      .map((u) => u.trim())
  )];
  if (wanted.length === 0) return { allowed: [], rejected: [] };

  const { rows } = await query(
    `SELECT username FROM developers
      WHERE org_id = $1 AND LOWER(username) = ANY($2::text[])`,
    [orgId, wanted.map((u) => u.toLowerCase())]
  );
  const roster = new Map(rows.map((r) => [r.username.toLowerCase(), r.username]));

  // Canonicalise to the roster's spelling and dedupe AFTER doing so: GitHub
  // usernames are case-insensitive, so "alice" and "Alice" are one person and
  // would otherwise be invited twice.
  const allowed = [...new Set(
    wanted.filter((u) => roster.has(u.toLowerCase())).map((u) => roster.get(u.toLowerCase()))
  )].slice(0, MAX_COLLABORATORS);

  const rejected = [...new Set(wanted.filter((u) => !roster.has(u.toLowerCase())))];
  return { allowed, rejected };
}

// POST /api/github/create-repo
// Body: { projectName, developers?: [githubUsername], description?, private? }
//
// Creates (or adopts) one repository per project and gives the project's team
// push access. Idempotent by design: re-running the wizard for the same project
// adopts the existing repo and tops up collaborators rather than failing or
// creating "my-project-2".
router.post('/github/create-repo', async (req, res) => {
  const warnings = [];
  try {
    const projectName = String(req.body?.projectName || '').trim();
    if (!projectName) {
      return res.status(400).json({ success: false, error: 'projectName is required' });
    }

    const repoName = toRepoName(projectName);
    if (!repoName) {
      return res.status(400).json({
        success: false,
        error: `"${projectName}" has no characters GitHub allows in a repository name.`,
      });
    }

    const github = await githubClientFor(req.orgId);

    // Owner: the org's configured GitHub organization, else the token's own
    // account. These are different create endpoints, so resolve it up front.
    const configuredOrg = await getGithubOwner(req.orgId);
    const me = await github.getAuthenticatedUser();
    const owner = configuredOrg || me.login;
    const isOrgOwned = !!configuredOrg;

    // Adopt an existing repo of the same name rather than failing the save.
    let repo = await getRepoSafely(github, owner, repoName);
    let created = false;

    if (repo) {
      warnings.push(
        `A repository named "${owner}/${repoName}" already existed — using it rather than creating a duplicate.`
      );
    } else {
      repo = await github.createRepo({
        owner: isOrgOwned ? owner : null,
        name: repoName,
        description: `${projectName} — created by Focus Flow`,
        isPrivate: req.body?.private !== false,
      });
      created = true;
    }

    // Collaborators, restricted to the roster.
    const requested = Array.isArray(req.body?.developers) ? req.body.developers : [];
    const { allowed, rejected } = await rosterUsernames(req.orgId, requested);
    if (rejected.length > 0) {
      warnings.push(
        `Not added (not on your team roster): ${rejected.join(', ')}. ` +
        'Add them on the Developers page first.'
      );
    }

    const invited = [];
    const alreadyMembers = [];
    for (const username of allowed) {
      // You cannot invite yourself to your own repository; GitHub 422s.
      if (!isOrgOwned && username.toLowerCase() === me.login.toLowerCase()) {
        alreadyMembers.push(username);
        continue;
      }
      const result = await github.addCollaborator(owner, repo.name, username, 'push');
      if (result.status === 'invited') invited.push(username);
      else if (result.status === 'already_member') alreadyMembers.push(username);
      else warnings.push(`${username}: ${result.error}`);
    }

    if (invited.length > 0) {
      warnings.push(
        `${invited.join(', ')} ${invited.length === 1 ? 'has' : 'have'} been invited and must ` +
        'accept the GitHub invitation before pushing.'
      );
    }

    return res.json({
      success: true,
      created,
      repo: {
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        private: repo.private,
        owner,
        ownerType: isOrgOwned ? 'organization' : 'user',
      },
      invited,
      alreadyMembers,
      warnings,
    });
  } catch (err) {
    return sendUpstreamError(res, err, { extra: { warnings } });
  }
});

// A 404 from getRepo means "does not exist"; anything else (403 on a private
// repo the token cannot see, a transient 5xx) must not be mistaken for absence,
// or we would try to create a repo that is already there.
async function getRepoSafely(github, owner, name) {
  try {
    return await github.getRepo(owner, name);
  } catch {
    return null;
  }
}

export default router;
