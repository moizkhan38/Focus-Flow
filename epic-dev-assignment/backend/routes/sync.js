import express from 'express';
import { sendUpstreamError } from '../utils/httpError.js';
import { jiraClientFor } from '../services/jiraClientFor.js';
import { generateProjectKey } from '../services/jiraService.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { requireFeature } from '../middleware/requirePlan.js';
import { FEATURES } from '../services/billing.js';

const router = express.Router();

// Only addresses that already belong to this org's developer roster may be
// invited to the tenant's Atlassian site.
//
// The invite step used to take its addresses straight from req.body
// (developerJiraMap), which made POST /api/ai/sync-jira an account-creation
// primitive: ANY org member — no admin role needed, and the /api gate only
// requires membership — could name an arbitrary external address and have the
// backend call POST /rest/api/3/user with the org's stored Jira ADMIN token,
// creating a real Atlassian account on the tenant's site and then adding it to
// the project role. The caller can never read the token, but they could aim it.
//
// The roster is the authority: an address must already be recorded against a
// developer in THIS org before it can be invited.
const INVITE_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_INVITES_PER_SYNC = 25;

async function allowedInviteEmails(orgId, requested) {
  const wanted = [...new Set(
    requested.filter((e) => typeof e === 'string' && INVITE_EMAIL_RE.test(e.trim()))
      .map((e) => e.trim().toLowerCase())
  )];
  if (wanted.length === 0) return { allowed: [], rejected: [] };

  const { rows } = await query(
    `SELECT LOWER(email) AS email FROM developers
      WHERE org_id = $1 AND email IS NOT NULL AND LOWER(email) = ANY($2::text[])`,
    [orgId, wanted]
  );
  const roster = new Set(rows.map((r) => r.email));
  const allowed = wanted.filter((e) => roster.has(e)).slice(0, MAX_INVITES_PER_SYNC);
  const rejected = wanted.filter((e) => !roster.has(e));
  return { allowed, rejected };
}
// Auth: enforced by the default-closed /api gate in server.js.
// Jira credentials are per-org (Phase 2): the handler resolves the caller's
// org client via jiraClientFor(req.orgId); orgs without a connected Jira get
// 412 JIRA_NOT_CONNECTED (mapped in utils/httpError.js).

/**
 * Distribute stories across sprints respecting dependencies and epic cohesion.
 *
 * Rules (in priority order):
 * 1. If story A blocks story B, A must be in the same or earlier sprint than B.
 * 2. Stories from the same epic are kept together when possible.
 * 3. Sprints are balanced by story points (greedy bin-packing).
 *
 * @param {Array} allStories - [{ storyId, key, storyPoints, epicIdx }]
 * @param {number} sprintCount
 * @param {Array} dependencies - [{ from: storyId, to: storyId }] (from blocks to)
 */
function distributeStoriesAcrossSprints(allStories, sprintCount, dependencies = []) {
  if (sprintCount <= 1) return [allStories];

  const bins = Array.from({ length: sprintCount }, () => ({ stories: [], points: 0 }));

  // Build dependency graph: blockerOf[storyId] = [storyIds it blocks]
  // and blockedBy[storyId] = [storyIds that block it]
  const blockedBy = {};   // storyId -> [blocker storyIds]
  const storyIdSet = new Set(allStories.map(s => s.storyId));
  for (const dep of dependencies) {
    if (!storyIdSet.has(dep.from) || !storyIdSet.has(dep.to)) continue;
    if (!blockedBy[dep.to]) blockedBy[dep.to] = [];
    blockedBy[dep.to].push(dep.from);
  }

  // Track which sprint each story is assigned to
  const sprintAssignment = {}; // storyId -> sprint index

  // Group stories by epic for cohesion
  const epicGroups = {};
  for (const story of allStories) {
    const key = story.epicIdx;
    if (!epicGroups[key]) epicGroups[key] = [];
    epicGroups[key].push(story);
  }

  // Sort epic groups by total points descending (larger groups placed first)
  const sortedGroups = Object.values(epicGroups).sort((a, b) => {
    const aPoints = a.reduce((s, st) => s + (st.storyPoints || 5), 0);
    const bPoints = b.reduce((s, st) => s + (st.storyPoints || 5), 0);
    return bPoints - aPoints;
  });

  // Place each epic group into the sprint with the lowest current load
  for (const group of sortedGroups) {
    // Find the minimum sprint index required by dependencies
    let minSprintIdx = 0;
    for (const story of group) {
      const blockers = blockedBy[story.storyId] || [];
      for (const blockerId of blockers) {
        const blockerSprint = sprintAssignment[blockerId];
        if (blockerSprint !== undefined && blockerSprint >= minSprintIdx) {
          // Blocked story must be in same or later sprint as its blocker
          minSprintIdx = blockerSprint;
        }
      }
    }

    // Among eligible sprints (>= minSprintIdx), find the one with lowest points
    let bestIdx = minSprintIdx;
    for (let i = minSprintIdx; i < bins.length; i++) {
      if (bins[i].points < bins[bestIdx].points) bestIdx = i;
    }

    // Place all stories in this group into the selected sprint
    for (const story of group) {
      bins[bestIdx].stories.push(story);
      bins[bestIdx].points += story.storyPoints || 5;
      sprintAssignment[story.storyId] = bestIdx;
    }
  }

  // Second pass: verify all dependency constraints are met
  // If a blocked story ended up before its blocker (due to epic grouping), move it later
  for (const dep of dependencies) {
    const fromSprint = sprintAssignment[dep.from];
    const toSprint = sprintAssignment[dep.to];
    if (fromSprint !== undefined && toSprint !== undefined && toSprint < fromSprint) {
      // dep.to is blocked by dep.from, but dep.to is in an earlier sprint — swap it
      const story = bins[toSprint].stories.find(s => s.storyId === dep.to);
      if (story) {
        // Remove from current sprint
        bins[toSprint].stories = bins[toSprint].stories.filter(s => s.storyId !== dep.to);
        bins[toSprint].points -= story.storyPoints || 5;
        // Move to blocker's sprint (or later)
        bins[fromSprint].stories.push(story);
        bins[fromSprint].points += story.storyPoints || 5;
        sprintAssignment[dep.to] = fromSprint;
        logger.info(`[Sync] Moved story ${dep.to} to sprint ${fromSprint + 1} (blocked by ${dep.from})`);
      }
    }
  }

  return bins.map(b => b.stories);
}

router.post('/ai/sync-jira', requireFeature(FEATURES.JIRA_SYNC, 'Syncing to Jira isn’t included in your plan. Upgrade to push epics, stories and sprints into your Jira site.'), async (req, res) => {
  const {
    epics = [],
    assignments = [],
    dependencies = [],
    deadline = null,
    projectName = 'Sprint',
    sprintCount: requestedSprintCount = 1,
    developerJiraMap = {},
  } = req.body;

  const approvedEpics = epics.filter((e) => e.status === 'approved');
  if (approvedEpics.length < 2) {
    return res.status(400).json({ error: 'At least 2 approved epics are required to sync.' });
  }

  // Sanitize projectName — strip control chars and limit length to prevent
  // malformed Jira API payloads or injection via display name
  const cleanProjectName = String(projectName).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80);
  if (!cleanProjectName) {
    return res.status(400).json({ error: 'Invalid project name.' });
  }

  // Collect non-fatal warnings to report back to frontend
  const warnings = [];

  try {
    const jira = await jiraClientFor(req.orgId);

    // Step 0: Auto-create Jira project and discover its board
    let projectKey;
    let jiraBoardId = null; // discovered from the auto-created project below

    const myself = await jira.getMyself();
    const leadAccountId = myself.accountId;
    req.log.info(`[Sync] Authenticated as: ${myself.displayName}`);

    let baseKey = generateProjectKey(cleanProjectName);
    let created = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidateKey = attempt === 0 ? baseKey : `${baseKey}${attempt + 1}`;
      try {
        const proj = await jira.createProject(cleanProjectName, candidateKey, leadAccountId);
        projectKey = proj.key || candidateKey;
        req.log.info(`[Sync] Created Jira project: ${projectKey}`);
        created = true;
        break;
      } catch (err) {
        if (err.status === 400 && err.message.toLowerCase().includes('key')) {
          req.log.warn(`[Sync] Project key "${candidateKey}" taken, trying next...`);
          continue;
        }
        throw err;
      }
    }
    if (!created) {
      throw new Error(`Could not create Jira project — all key variants for "${baseKey}" are taken`);
    }

    // Set assigneeType to UNASSIGNED so new issues aren't auto-assigned to the project lead
    try {
      await jira.updateProjectSettings(projectKey, { assigneeType: 'UNASSIGNED' });
      req.log.info(`[Sync] Set project ${projectKey} default assignee to UNASSIGNED`);
    } catch (err) {
      req.log.warn(`[Sync] Could not change assignee type: ${err.message}`);
    }

    // Discover the auto-created board for this project (retry with backoff)
    if (!jiraBoardId) {
      const delays = [2000, 4000, 8000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        const boards = await jira.getProjectBoards(projectKey);
        const scrumBoard = boards.find(b => b.type === 'scrum');
        const selectedBoard = scrumBoard || boards[0];
        if (selectedBoard) {
          jiraBoardId = selectedBoard.id;
          req.log.info(`[Sync] Found board: ${selectedBoard.name} (ID: ${jiraBoardId}, type: ${selectedBoard.type}) on attempt ${attempt + 1}`);
          if (selectedBoard.type !== 'scrum') {
            warnings.push(`Board "${selectedBoard.name}" is ${selectedBoard.type} type — sprints may not be supported`);
          }
          break;
        }
        if (attempt < delays.length - 1) {
          req.log.warn(`[Sync] No board found on attempt ${attempt + 1}, retrying...`);
        }
      }
      if (!jiraBoardId) {
        warnings.push('No board found for project after 3 attempts — sprint creation will be skipped');
        req.log.warn('[Sync] No board found for project — sprint creation will be skipped');
      }
    }

    // Step 1: Calculate total project duration with validation
    const startDate = new Date();
    const endDate = new Date();
    if (deadline && deadline.value) {
      const v = Math.max(1, parseInt(deadline.value) || 2); // Ensure positive value
      switch (deadline.unit) {
        case 'hours':  endDate.setHours(endDate.getHours() + v); break;
        case 'days':   endDate.setDate(endDate.getDate() + v); break;
        case 'months': endDate.setMonth(endDate.getMonth() + v); break;
        case 'weeks':
        default:       endDate.setDate(endDate.getDate() + v * 7); break;
      }
    } else {
      endDate.setDate(endDate.getDate() + 14);
    }

    // Validate date range
    if (endDate <= startDate) {
      endDate.setDate(startDate.getDate() + 14);
      warnings.push('Invalid deadline — defaulting to 2 weeks');
    }

    const numSprints = Math.max(1, Math.min(10, parseInt(requestedSprintCount) || 1));
    const totalMs = endDate.getTime() - startDate.getTime();
    const sprintMs = totalMs / numSprints;

    // Step 2: Create sprints on the Jira board
    const sprints = [];
    if (jiraBoardId) {
      for (let i = 0; i < numSprints; i++) {
        try {
          const sStart = new Date(startDate.getTime() + sprintMs * i);
          const sEnd = new Date(startDate.getTime() + sprintMs * (i + 1));
          const sprintName = numSprints > 1
            ? `${cleanProjectName} - Sprint ${i + 1}`
            : `${cleanProjectName} - Sprint`;
          const sprint = await jira.createSprint(jiraBoardId, sprintName, sStart.toISOString(), sEnd.toISOString());
          sprints.push(sprint);
          req.log.info(`[Sync] Created sprint: ${sprint.name} (ID: ${sprint.id})`);
        } catch (err) {
          const msg = `Sprint ${i + 1} creation failed: ${err.message}`;
          warnings.push(msg);
          req.log.warn(`[Sync] ${msg}`);
        }
      }
    }

    // Step 3: Build story-level assignment lookup { story_id -> github_username }
    // Supports both story-level and legacy epic-level assignments
    const storyAssignmentMap = {};
    const epicAssignmentMap = {};
    for (const a of assignments) {
      if (a.story_id && a.assigned_developer) {
        storyAssignmentMap[a.story_id] = a.assigned_developer;
      }
      if (a.epic_id && a.assigned_developer) {
        epicAssignmentMap[a.epic_id] = a.assigned_developer;
      }
    }

    // Step 4: Resolve Jira accountIds from developer usernames
    // Uses developerJiraMap (Jira email provided by user) or falls back to GitHub username search
    const allDevUsernames = new Set([...Object.values(storyAssignmentMap), ...Object.values(epicAssignmentMap)]);
    const accountIdCache = {};
    const unresolvedUsers = [];
    const fuzzyMatches = [];
    for (const username of allDevUsernames) {
      if (!username) continue;
      const jiraQuery = developerJiraMap[username] || null;
      const hasExplicitMapping = !!jiraQuery;

      try {
        // Try the explicit Jira email/username first, then fall back to GitHub username
        let users = [];
        if (hasExplicitMapping) {
          users = await jira.searchUser(jiraQuery);
        }
        if (users.length === 0) {
          // Fall back to GitHub username search
          users = await jira.searchUser(username);
          if (users.length > 0 && !hasExplicitMapping) {
            fuzzyMatches.push(`${username} → ${users[0].displayName} (matched by name, not email)`);
          }
        }

        if (users.length > 0) {
          accountIdCache[username] = users[0].accountId;
          req.log.info(`[Sync] Resolved Jira user: ${username} → ${users[0].displayName} (${hasExplicitMapping ? 'by email' : 'by name search'})`);
        } else {
          unresolvedUsers.push(username);
          req.log.warn(`[Sync] No active Jira user found for "${username}"${hasExplicitMapping ? ` (tried: ${jiraQuery})` : ''}`);
        }
      } catch (err) {
        unresolvedUsers.push(username);
        req.log.warn(`[Sync] Could not find Jira user for "${username}": ${err.message}`);
      }
    }
    // Invite unresolved users who have Jira emails
    const invitedUsers = [];
    if (unresolvedUsers.length > 0) {
      const requestedEmails = unresolvedUsers
        .map(u => developerJiraMap[u])
        .filter(Boolean);

      // Never invite an address the caller simply typed into the request body —
      // it must already be on this org's developer roster. See allowedInviteEmails.
      const { allowed: emailsToInvite, rejected } = await allowedInviteEmails(req.orgId, requestedEmails);
      if (rejected.length > 0) {
        req.log.warn(
          `[Sync] Refused to invite ${rejected.length} address(es) not on the org's developer roster`
        );
        warnings.push(
          `Not invited (not on your team roster): ${rejected.join(', ')}. ` +
          'Add them on the Developers page first — this prevents arbitrary addresses ' +
          'being given accounts on your Jira site.'
        );
      }

      if (emailsToInvite.length > 0) {
        try {
          const inviteResults = await jira.inviteUsersToJira(emailsToInvite);
          for (const result of inviteResults) {
            // allowedInviteEmails normalizes to lowercase, so match case-insensitively.
            const username = Object.entries(developerJiraMap)
              .find(([, email]) => String(email || '').toLowerCase() === String(result.email || '').toLowerCase())?.[0];
            if (!username) {
              req.log.warn(`[Sync] No developer mapping found for invited email ${result.email} — skipping`);
              continue;
            }
            if (result.status === 'invited' && result.accountId) {
              accountIdCache[username] = result.accountId;
              invitedUsers.push(`${username} (${result.email})`);
              // Remove from unresolved
              const idx = unresolvedUsers.indexOf(username);
              if (idx >= 0) unresolvedUsers.splice(idx, 1);
              req.log.info(`[Sync] Invited ${result.email} to Jira → ${result.displayName}`);
            } else if (result.status === 'already_exists') {
              // User exists but wasn't found by search — retry search after invite
              const retryUsers = await jira.searchUser(result.email);
              if (retryUsers.length > 0 && username) {
                accountIdCache[username] = retryUsers[0].accountId;
                const idx = unresolvedUsers.indexOf(username);
                if (idx >= 0) unresolvedUsers.splice(idx, 1);
                req.log.info(`[Sync] Found existing user on retry: ${username} → ${retryUsers[0].displayName}`);
              }
            } else if (result.status === 'failed') {
              req.log.warn(`[Sync] Failed to invite ${result.email}: ${result.error}`);
            }
          }
        } catch (err) {
          req.log.warn(`[Sync] Invitation batch failed: ${err.message}`);
        }
      }

      if (unresolvedUsers.length > 0) {
        warnings.push(`Could not resolve Jira accounts for: ${unresolvedUsers.join(', ')}. Add their Jira emails in the Team Mapping section.`);
      }
    }
    if (invitedUsers.length > 0) {
      warnings.push(`Invited to Jira: ${invitedUsers.join(', ')} — they will receive email invitations.`);
    }
    if (fuzzyMatches.length > 0) {
      warnings.push(`Fuzzy-matched developers (verify these are correct): ${fuzzyMatches.join('; ')}`);
    }

    // Step 4b: Add developers to the Jira project team
    // Try multiple methods to ensure developers can be assigned issues
    const resolvedAccountIds = Object.values(accountIdCache).filter(Boolean);
    if (resolvedAccountIds.length > 0) {
      try {
        const roles = await jira.getProjectRoles(projectKey);
        req.log.info(`[Sync] Available project roles: ${JSON.stringify(roles)}`);

        // Get ALL role IDs (including addons role) — try every role
        const allRoleIds = Object.values(roles);

        let addedCount = 0;
        for (const accountId of resolvedAccountIds) {
          let addedToAny = false;
          // Try adding to every available role
          for (const roleId of allRoleIds) {
            try {
              await jira.addUserToProjectRole(projectKey, roleId, accountId);
              addedToAny = true;
              req.log.info(`[Sync] Added user ${accountId} to role ${roleId}`);
            } catch (err) {
              // Role add may fail (already a member, wrong role type) — try next
            }
          }

          // Also try to set the user as a project lead (grants all permissions)
          try {
            await jira.updateProjectLead(projectKey, accountId);
            req.log.info(`[Sync] Set user ${accountId} as project lead (temporary)`);
          } catch (err) {
            // Non-fatal — just trying to grant permissions
          }

          if (addedToAny) addedCount++;
        }

        // Restore the original project lead (the API user)
        try {
          await jira.updateProjectLead(projectKey, leadAccountId);
        } catch (_) {}

        req.log.info(`[Sync] Added ${addedCount}/${resolvedAccountIds.length} developers to project`);
        if (addedCount < resolvedAccountIds.length) {
          warnings.push(`Only ${addedCount}/${resolvedAccountIds.length} developers added to project team`);
        }
      } catch (err) {
        warnings.push(`Could not set up project team: ${err.message}`);
        req.log.warn(`[Sync] Could not set up project team: ${err.message}`);
      }
    }

    // Step 4c: Verify which developers are actually assignable in this project
    // (users may exist in Jira but lack product access or project permissions)
    // Search by Jira email/username first (from developerJiraMap), then by accountId.
    // Do NOT search by GitHub username — it rarely matches a Jira display name.
    const assignableCache = {};
    for (const [username, accountId] of Object.entries(accountIdCache)) {
      try {
        // Use the Jira email/username provided by the user, fall back to accountId search
        const jiraQuery = developerJiraMap[username] || accountId;
        const assignable = await jira.searchAssignableUser(jiraQuery, projectKey);
        const match = assignable.find(u => u.accountId === accountId);
        if (match) {
          assignableCache[username] = accountId;
          req.log.info(`[Sync] Verified ${username} is assignable in project ${projectKey}`);
        } else {
          // Try searching by account ID directly
          const byId = await jira.searchAssignableUser(accountId, projectKey);
          if (byId.length > 0) {
            assignableCache[username] = accountId;
            req.log.info(`[Sync] Verified ${username} is assignable (by accountId)`);
          } else {
            // We found this user in Jira (accountIdCache has them) — try assigning anyway.
            // They may have just been added to the project and Jira's index hasn't caught up.
            assignableCache[username] = accountId;
            req.log.warn(`[Sync] ${username} not confirmed assignable yet — will attempt assignment anyway`);
            warnings.push(`${username} may need to accept their Jira invitation before they appear as assignable`);
          }
        }
      } catch (err) {
        req.log.warn(`[Sync] Could not verify assignability for ${username}: ${err.message}`);
        // Still try to assign — it might work
        assignableCache[username] = accountId;
      }
    }
    req.log.info(`[Sync] Assignable developers: ${Object.keys(assignableCache).join(', ') || 'none'}`);

    // Step 5: Create epics and stories, assign devs, set story points
    const results = [];
    const allCreatedStories = []; // { key, storyPoints, epicIdx }
    let assignmentFailures = 0;
    let pointsFailures = 0;

    for (let eIdx = 0; eIdx < approvedEpics.length; eIdx++) {
      const epic = approvedEpics[eIdx];
      const createdEpic = await jira.createEpic(projectKey, epic.title, epic.description || '');
      const epicKey = createdEpic.key;
      req.log.info(`[Sync] Created epic: ${epicKey} - ${epic.title}`);

      // Assign developer to epic
      const epicDevUsername = epicAssignmentMap[epic.id];
      if (epicDevUsername && assignableCache[epicDevUsername]) {
        try { await jira.assignIssue(epicKey, assignableCache[epicDevUsername]); } catch (err) {
          assignmentFailures++;
          req.log.warn(`[Sync] Could not assign ${epicKey} to ${epicDevUsername}: ${err.message}`);
        }
      }

      const storyResults = [];
      const approvedStories = (epic.stories || []).filter((s) => s.status === 'approved');

      for (const story of approvedStories) {
        const createdStory = await jira.createStory(
          projectKey, story.title,
          story.description || '', story.acceptanceCriteria || '',
          epicKey, story.testCases || []
        );
        req.log.info(`[Sync] Created story: ${createdStory.key} - ${story.title}`);

        // Set story points
        const sp = parseInt(story.storyPoints || 5);
        if (sp) {
          try { await jira.updateStoryPoints(createdStory.key, sp); } catch (err) {
            pointsFailures++;
            req.log.warn(`[Sync] Could not set story points on ${createdStory.key}: ${err.message}`);
          }
        }

        // Assign developer — story-level first, fall back to epic-level
        const storyDevUsername = storyAssignmentMap[story.id] || epicDevUsername;
        if (storyDevUsername && assignableCache[storyDevUsername]) {
          try { await jira.assignIssue(createdStory.key, assignableCache[storyDevUsername]); } catch (err) {
            assignmentFailures++;
            req.log.warn(`[Sync] Could not assign ${createdStory.key} to ${storyDevUsername}: ${err.message}`);
          }
        }

        storyResults.push({ storyId: story.id, storyKey: createdStory.key });
        allCreatedStories.push({ storyId: story.id, key: createdStory.key, storyPoints: sp, epicIdx: eIdx });
      }

      results.push({ epicId: epic.id, epicKey, stories: storyResults });
    }

    if (assignmentFailures > 0) {
      warnings.push(`${assignmentFailures} issue assignment(s) failed — check Jira user permissions`);
    }
    if (pointsFailures > 0) {
      warnings.push(`${pointsFailures} story point update(s) failed — story points field may not be configured`);
    }

    // Step 6: Distribute stories across sprints and move them
    let moveFailures = 0;
    if (sprints.length > 0 && allCreatedStories.length > 0) {
      if (sprints.length === 1) {
        // Single sprint: move all stories (not epics — epics don't belong in sprints)
        const storyKeys = allCreatedStories.map(s => s.key);
        try {
          await jira.moveIssueToSprint(sprints[0].id, storyKeys);
          req.log.info(`[Sync] Moved ${storyKeys.length} stories to sprint ${sprints[0].id}`);
        } catch (err) {
          moveFailures += storyKeys.length;
          req.log.warn(`[Sync] Could not move stories to sprint: ${err.message}`);
        }
      } else {
        // Multi-sprint: distribute stories by points
        const storyBins = distributeStoriesAcrossSprints(allCreatedStories, sprints.length, dependencies);

        // Move story batches to their sprints
        for (let i = 0; i < sprints.length; i++) {
          const storyKeys = storyBins[i]?.map(s => s.key) || [];
          if (storyKeys.length === 0) continue;
          try {
            await jira.moveIssueToSprint(sprints[i].id, storyKeys);
            req.log.info(`[Sync] Moved ${storyKeys.length} stories to sprint ${i + 1} (ID: ${sprints[i].id})`);
          } catch (err) {
            moveFailures += storyKeys.length;
            req.log.warn(`[Sync] Could not move stories to sprint ${i + 1}: ${err.message}`);
          }
        }
      }
    }

    if (moveFailures > 0) {
      warnings.push(`${moveFailures} issue(s) could not be moved to sprints`);
    }

    // Step 7: Start the first sprint so it appears on the board
    // Wait briefly for Jira to finish indexing issues moved to the sprint
    if (sprints.length > 0) {
      await new Promise(r => setTimeout(r, 2000));
      const s1Start = new Date(startDate.getTime());
      const s1End = new Date(startDate.getTime() + sprintMs);
      let sprintStarted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await jira.startSprint(sprints[0].id, s1Start.toISOString(), s1End.toISOString(), jiraBoardId, sprints[0].name);
          req.log.info(`[Sync] Started sprint: ${sprints[0].name} (ID: ${sprints[0].id}) on attempt ${attempt + 1}`);
          sprintStarted = true;
          break;
        } catch (err) {
          req.log.warn(`[Sync] Sprint start attempt ${attempt + 1} failed: ${err.message}`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!sprintStarted) {
        warnings.push('Could not start sprint — you may need to start it manually in Jira');
      }
    }

    res.json({
      results,
      sprintId: sprints[0]?.id || null,
      sprintName: sprints[0]?.name || null,
      sprintCount: sprints.length,
      sprints: sprints.map(s => ({ id: s.id, name: s.name })),
      totalIssues: results.reduce((s, r) => s + 1 + r.stories.length, 0),
      jiraProjectKey: projectKey,
      jiraBoardId: jiraBoardId,
      teamMembers: Object.keys(accountIdCache),
      invitedDevelopers: invitedUsers,
      warnings,
    });
  } catch (err) {
    req.log.error('[Sync] Error:', err);
    sendUpstreamError(res, err);
  }
});

export default router;
