import fetch from 'node-fetch';

// Per-org Jira client factory (Phase 2, step 2.5).
//
// Credentials are no longer read from env — each org connects its own Jira via
// the Settings UI (stored encrypted in org_integrations). Obtain a client with
//   const jira = await jiraClientFor(req.orgId)   // services/jiraClientFor.js
// which resolves the org's credentials and calls createJiraClient(creds).
// Every method keeps its pre-factory signature and behavior.

/**
 * Parse Jira error response into a readable message.
 * Handles multiple Jira error formats: errorMessages[], errors{}, error_description.
 */
function parseJiraError(err, fallbackStatus) {
  if (err.errorMessages?.length) return err.errorMessages[0];
  if (err.errors && Object.keys(err.errors).length > 0) return Object.values(err.errors).join(', ');
  if (err.error_description) return err.error_description;
  if (err.message) return err.message;
  return `Jira API error: ${fallbackStatus}`;
}

// ─── Custom Field Discovery cache ────────────────────────────────────────────
// Jira Cloud custom field IDs vary per instance. Discovered dynamically and
// cached PER DOMAIN (multi-tenant: each org's Jira has its own field ids).
const _fieldCaches = new Map(); // domain -> { fields, fetchedAt }
const FIELD_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Status categories that indicate "done" — case-insensitive ──────────────
const DONE_CATEGORIES = new Set(['done', 'complete', 'completed', 'closed', 'resolved']);

export function isDoneCategory(statusCategory) {
  return DONE_CATEGORIES.has((statusCategory || '').toLowerCase());
}

// ─── Pure helpers (no credentials involved) ──────────────────────────────────

export function generateProjectKey(name) {
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  let key;
  if (words.length >= 2) {
    key = words.map((w) => w[0]).join('').toUpperCase().slice(0, 10);
  } else {
    key = (words[0] || 'PROJ').toUpperCase().slice(0, 10);
  }
  if (key.length < 2) key = key + 'X';
  return key;
}

/**
 * Extract story points from issue fields using discovered field ID.
 */
function extractStoryPoints(issueFields, spField) {
  if (spField && issueFields[spField] != null) return issueFields[spField];
  // Fallback checks for common field IDs
  return issueFields.customfield_10016 || issueFields.customfield_10028 || null;
}

/**
 * Map a raw Jira issue to our normalized format.
 */
function mapIssue(issue, spField) {
  const f = issue.fields;
  return {
    id: issue.id,
    key: issue.key,
    summary: f.summary,
    status: f.status?.name || 'To Do',
    statusCategory: f.status?.statusCategory?.name || 'To Do',
    issueType: f.issuetype?.name || 'Story',
    priority: f.priority?.name || 'Medium',
    assignee: f.assignee
      ? { name: f.assignee.displayName, accountId: f.assignee.accountId, emailAddress: f.assignee.emailAddress || null, avatarUrl: f.assignee.avatarUrls?.['48x48'] }
      : null,
    storyPoints: extractStoryPoints(f, spField),
    labels: f.labels || [],
    created: f.created,
    updated: f.updated,
    resolutionDate: f.resolutiondate || null,
    statusCategoryChangeDate: f.statuscategorychangedate || null,
  };
}

// ─── Client factory ──────────────────────────────────────────────────────────

/**
 * Create a Jira client bound to one organization's credentials.
 * @param {{domain: string, email: string, apiToken: string}} creds
 */
export function createJiraClient({ domain, email, apiToken }) {
  if (!domain || !email || !apiToken) {
    throw new Error('createJiraClient requires domain, email, and apiToken');
  }

  const authHeaders = {
    Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  function jiraFetch(path, options = {}) {
    const url = `https://${domain}${path}`;
    return fetch(url, { ...options, headers: { ...authHeaders, ...(options.headers || {}) } });
  }

  async function discoverFields() {
    const now = Date.now();
    const cached = _fieldCaches.get(domain);
    if (cached && now - cached.fetchedAt < FIELD_CACHE_TTL) return cached.fields;

    try {
      const res = await jiraFetch('/rest/api/3/field');
      if (!res.ok) throw new Error(`Field discovery failed: ${res.status}`);
      const fields = await res.json();

      const result = {
        storyPointsField: null,
        epicLinkField: null,
        epicNameField: null,
      };

      for (const f of fields) {
        const id = f.id;
        const name = (f.name || '').toLowerCase();
        const schema = f.schema || {};

        // Story Points — look for the field by name or known custom type
        if (!result.storyPointsField) {
          if (name === 'story points' || name === 'story point estimate'
            || schema.custom === 'com.atlassian.jira.plugin.system.customfieldtypes:float'
               && name.includes('story')) {
            result.storyPointsField = id;
          }
        }

        // Epic Link — the field that links stories to epics
        if (!result.epicLinkField) {
          if (name === 'epic link' || schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link') {
            result.epicLinkField = id;
          }
        }

        // Epic Name — used when creating epics
        if (!result.epicNameField) {
          if (name === 'epic name' || schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-label') {
            result.epicNameField = id;
          }
        }
      }

      // Fallback to common defaults if discovery failed
      if (!result.storyPointsField) result.storyPointsField = 'customfield_10016';
      if (!result.epicLinkField) result.epicLinkField = 'customfield_10014';

      _fieldCaches.set(domain, { fields: result, fetchedAt: now });
      console.log(`[Jira] Field discovery (${domain}): SP=${result.storyPointsField}, EpicLink=${result.epicLinkField}, EpicName=${result.epicNameField || 'N/A'}`);
      return result;
    } catch (err) {
      console.warn(`[Jira] Field discovery failed for ${domain}, using defaults: ${err.message}`);
      // Do NOT cache the fallback: the failure may be THIS org's bad credentials
      // (401), and the cache key is the shared domain — caching would poison
      // every org on this domain with hardcoded field ids for the TTL. Returning
      // without caching means the next call (possibly another org, valid creds)
      // re-runs discovery.
      return {
        storyPointsField: 'customfield_10016',
        epicLinkField: 'customfield_10014',
        epicNameField: null,
      };
    }
  }

  /**
   * Build the field list for issue queries, including discovered custom fields.
   */
  async function getIssueFieldList() {
    const fields = await discoverFields();
    const base = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'labels',
      'created', 'updated', 'resolutiondate', 'statuscategorychangedate'];
    if (fields.storyPointsField) base.push(fields.storyPointsField);
    return { fieldList: base.join(','), spField: fields.storyPointsField };
  }

  // ─── Sprints ────────────────────────────────────────────────────────────────

  async function getSprints(boardId) {
    if (!boardId) {
      throw new Error('boardId is required to list sprints');
    }
    // Paginate to retrieve all sprints (Agile API max is 50 per page)
    let allSprints = [];
    let startAt = 0;
    while (true) {
      const res = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?maxResults=50&startAt=${startAt}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(parseJiraError(err, res.status));
      }
      const data = await res.json();
      const sprints = (data.values || []).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        startDate: s.startDate,
        endDate: s.endDate,
        goal: s.goal,
      }));
      allSprints = allSprints.concat(sprints);
      if (data.isLast !== false || sprints.length === 0) break;
      startAt += sprints.length;
    }
    return allSprints;
  }

  async function getSprintDetails(sprintId) {
    const res = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const s = await res.json();
    // originBoardId is what middleware/jiraScope.js uses to decide whether this
    // sprint belongs to a board the calling org actually owns — keep it.
    return {
      id: s.id, name: s.name, state: s.state,
      startDate: s.startDate, endDate: s.endDate, goal: s.goal,
      originBoardId: s.originBoardId ?? null,
    };
  }

  // ─── Issues ────────────────────────────────────────────────────────────────

  async function getSprintIssues(sprintId) {
    const { fieldList, spField } = await getIssueFieldList();
    const res = await jiraFetch(
      `/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=200&fields=${fieldList}`
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    return (data.issues || []).map((issue) => mapIssue(issue, spField));
  }

  async function getProjectIssues(projectKey) {
    const { fieldList, spField } = await getIssueFieldList();
    // Normalize to Jira format (uppercase) and validate — users may type "scrum"
    // and the system should accept it as "SCRUM". Strict whitelist rejects anything
    // containing quotes, spaces, or JQL operators.
    if (typeof projectKey !== 'string') {
      throw new Error(`Invalid project key: "${projectKey}"`);
    }
    const normalizedKey = projectKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(normalizedKey)) {
      throw new Error(`Invalid project key: "${projectKey}" (must be 2–10 alphanumeric chars starting with a letter)`);
    }
    const jql = `project = "${normalizedKey}" AND issuetype != Epic ORDER BY status ASC, key ASC`;
    const res = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: 200,
        fields: fieldList.split(','),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    return (data.issues || []).map((issue) => mapIssue(issue, spField));
  }

  // ─── Burndown ────────────────────────────────────────────────────────────────

  async function getBurndownData(sprintId) {
    const [sprint, issues] = await Promise.all([getSprintDetails(sprintId), getSprintIssues(sprintId)]);

    if (!sprint.startDate || !sprint.endDate) return [];

    const start = new Date(sprint.startDate);
    const end = new Date(sprint.endDate);
    const now = new Date();
    const totalDays = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));

    // Count story points — if custom fields are null, fall back to counting issues as 1 point each
    const nonEpicIssues = issues.filter(i => (i.issueType || '').toLowerCase() !== 'epic');
    let totalPoints = nonEpicIssues.reduce((sum, i) => sum + (i.storyPoints || 0), 0);
    const hasStoryPoints = totalPoints > 0;
    if (!hasStoryPoints) {
      totalPoints = nonEpicIssues.length;
    }

    const completionDates = nonEpicIssues
      .filter(i => isDoneCategory(i.statusCategory))
      .map(i => ({
        points: hasStoryPoints ? (i.storyPoints || 0) : 1,
        completedAt: new Date(i.resolutionDate || i.statusCategoryChangeDate || i.updated),
      }));

    const currentDonePoints = nonEpicIssues
      .filter(i => isDoneCategory(i.statusCategory))
      .reduce((sum, i) => sum + (hasStoryPoints ? (i.storyPoints || 0) : 1), 0);

    const points = [];

    for (let d = 0; d <= totalDays; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + d);
      if (date > now) break;

      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const dateStr = date.toISOString().split('T')[0];
      const ideal = totalPoints - (totalPoints / totalDays) * d;
      const completedPoints = completionDates
        .filter(c => c.completedAt <= endOfDay)
        .reduce((sum, c) => sum + c.points, 0);

      points.push({
        day: `Day ${d + 1}`,
        date: dateStr,
        ideal: Math.max(0, Math.round(ideal)),
        actual: Math.max(0, totalPoints - completedPoints),
      });
    }

    if (points.length === 1) {
      const elapsed = (now - start) / (1000 * 60 * 60 * 24);
      const idealNow = totalPoints - (totalPoints / totalDays) * elapsed;
      points.push({
        day: 'Now',
        date: now.toISOString().split('T')[0],
        ideal: Math.max(0, Math.round(idealNow)),
        actual: Math.max(0, totalPoints - currentDonePoints),
      });
    }

    console.log(`[Burndown] Sprint ${sprintId}: ${nonEpicIssues.length} stories, ${totalPoints} points (${hasStoryPoints ? 'SP' : 'count'}), ${currentDonePoints} done, ${points.length} data points`);

    return points;
  }

  // ─── Transitions ────────────────────────────────────────────────────────────

  async function getIssueTransitions(issueKey) {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    return (data.transitions || []).map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to?.name,
      toCategory: t.to?.statusCategory?.name || null,
    }));
  }

  async function transitionIssue(issueKey, transitionId) {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
  }

  // ─── Issue Creation ─────────────────────────────────────────────────────────

  async function createEpic(projectKey, title, description) {
    const res = await jiraFetch('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: title,
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description || title }] }],
          },
          issuetype: { name: 'Epic' },
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function createStory(projectKey, title, description, acceptanceCriteria, epicKey, testCases) {
    const fields = await discoverFields();

    // Build ADF content blocks for the issue description
    const contentBlocks = [];

    if (description) {
      contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: description }] });
    }

    if (acceptanceCriteria) {
      contentBlocks.push(
        { type: 'paragraph', content: [{ type: 'text', text: '\nAcceptance Criteria:', marks: [{ type: 'strong' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: acceptanceCriteria }] }
      );
    }

    if (testCases && testCases.length > 0) {
      for (const tc of testCases) {
        const tcParts = [];
        if (tc.id) tcParts.push(`[${tc.id}]`);
        tcParts.push(tc.description || 'Test Case');
        contentBlocks.push(
          { type: 'paragraph', content: [{ type: 'text', text: `\nTest Case: ${tcParts.join(' ')}`, marks: [{ type: 'strong' }] }] }
        );
        if (tc.preconditions) {
          contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: `Preconditions: ${tc.preconditions}` }] });
        }
        if (tc.testData) {
          contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: `Test Data: ${tc.testData}` }] });
        }
        if (tc.userAction) {
          contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: `Steps: ${tc.userAction}` }] });
        }
        if (tc.expectedResults && tc.expectedResults.length > 0) {
          contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: 'Expected Results:' }] });
          contentBlocks.push({
            type: 'orderedList',
            content: tc.expectedResults.map((r) => ({
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: r }] }],
            })),
          });
        }
      }
    }

    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'paragraph', content: [{ type: 'text', text: title }] });
    }

    const body = {
      fields: {
        project: { key: projectKey },
        summary: title,
        description: {
          type: 'doc',
          version: 1,
          content: contentBlocks,
        },
        issuetype: { name: 'Story' },
      },
    };

    // Set epic link using discovered field ID
    if (epicKey && fields.epicLinkField) {
      body.fields[fields.epicLinkField] = epicKey;
    }

    const res = await jiraFetch('/rest/api/3/issue', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  // ─── Connection & Auth ──────────────────────────────────────────────────────

  async function testConnection() {
    const res = await jiraFetch('/rest/api/3/myself');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function getBoards() {
    const res = await jiraFetch('/rest/agile/1.0/board?maxResults=50');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    return (data.values || []).map((b) => ({ id: b.id, name: b.name, type: b.type }));
  }

  // ─── Sprint Management ──────────────────────────────────────────────────────

  async function createSprint(boardId, name, startDate, endDate) {
    const res = await jiraFetch('/rest/agile/1.0/sprint', {
      method: 'POST',
      body: JSON.stringify({
        name,
        startDate,
        endDate,
        originBoardId: parseInt(boardId),
        goal: `Auto-created sprint for ${name}`,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function startSprint(sprintId, startDate, endDate, boardId, sprintName) {
    // If there's already an active sprint on this board, close it first
    if (boardId) {
      try {
        const existingSprints = await getSprints(boardId);
        const activeSprint = existingSprints.find(s => s.state === 'active');
        if (activeSprint && activeSprint.id !== sprintId) {
          console.log(`[Jira] Closing existing active sprint ${activeSprint.id} (${activeSprint.name}) to activate new one`);
          const closeRes = await jiraFetch(`/rest/agile/1.0/sprint/${activeSprint.id}`, {
            method: 'PUT',
            body: JSON.stringify({ state: 'closed' }),
          });
          if (!closeRes.ok) {
            // Sprint may already be closed — non-fatal
            console.warn(`[Jira] Sprint close returned ${closeRes.status} — may already be closed`);
          }
        }
      } catch (err) {
        console.warn(`[Jira] Could not check/close existing active sprint: ${err.message}`);
      }
    }

    const body = { state: 'active' };
    if (sprintName) body.name = sprintName;
    if (startDate) body.startDate = startDate;
    if (endDate) body.endDate = endDate;
    const res = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function closeSprint(sprintId) {
    const res = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}`, {
      method: 'PUT',
      body: JSON.stringify({ state: 'closed' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function moveIssueToSprint(sprintId, issueKeys) {
    const res = await jiraFetch(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: 'POST',
      body: JSON.stringify({ issues: issueKeys }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
  }

  // ─── Issue Operations ───────────────────────────────────────────────────────

  async function assignIssue(issueKey, accountId) {
    // Try the assignee endpoint first
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/assignee`, {
      method: 'PUT',
      body: JSON.stringify({ accountId }),
    });
    if (res.ok) return;

    // If assignee endpoint fails (permission issue), try updating the issue fields directly
    const err = await res.json().catch(() => ({}));
    const errMsg = parseJiraError(err, res.status);

    if (errMsg.includes('cannot be assigned')) {
      console.log(`[Jira] Assignee endpoint failed for ${issueKey}, trying issue field update...`);
      const fieldRes = await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: { assignee: { accountId } } }),
      });
      if (fieldRes.ok) return;
      const fieldErr = await fieldRes.json().catch(() => ({}));
      throw new Error(parseJiraError(fieldErr, fieldRes.status));
    }

    throw new Error(errMsg);
  }

  async function updateStoryPoints(issueKey, points) {
    const fields = await discoverFields();
    const fieldId = fields.storyPointsField;
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { [fieldId]: points } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
  }

  // ─── User Management ────────────────────────────────────────────────────────

  /**
   * Search for a Jira user by query string.
   * Jira's user search matches against displayName, emailAddress, and accountId.
   * Returns active users sorted by relevance (exact email match first).
   */
  async function searchUser(query) {
    const res = await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=10`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const users = await res.json();
    const activeUsers = users.filter(u => u.active !== false);

    const lowerQuery = query.toLowerCase();
    activeUsers.sort((a, b) => {
      const aEmail = (a.emailAddress || '').toLowerCase() === lowerQuery ? -1 : 0;
      const bEmail = (b.emailAddress || '').toLowerCase() === lowerQuery ? -1 : 0;
      if (aEmail !== bEmail) return aEmail - bEmail;
      const aName = (a.displayName || '').toLowerCase() === lowerQuery ? -1 : 0;
      const bName = (b.displayName || '').toLowerCase() === lowerQuery ? -1 : 0;
      return aName - bName;
    });

    return activeUsers;
  }

  /**
   * Search for users who can be assigned issues in a specific project.
   * Returns only users with proper Jira product access + project permissions.
   */
  async function searchAssignableUser(query, projectKey) {
    const res = await jiraFetch(
      `/rest/api/3/user/assignable/search?query=${encodeURIComponent(query)}&project=${encodeURIComponent(projectKey)}&maxResults=10`
    );
    if (!res.ok) return [];
    const users = await res.json();
    return users.filter(u => u.active !== false);
  }

  // ─── Project Management ─────────────────────────────────────────────────────

  async function getMyself() {
    const res = await jiraFetch('/rest/api/3/myself');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function createProject(name, key, leadAccountId) {
    const res = await jiraFetch('/rest/api/3/project', {
      method: 'POST',
      body: JSON.stringify({
        key,
        name,
        projectTypeKey: 'software',
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
        leadAccountId,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = parseJiraError(err, res.status);
      const error = new Error(msg);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  async function updateProjectLead(projectKey, leadAccountId) {
    const res = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ leadAccountId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  /**
   * Update project settings (e.g., assigneeType: 'UNASSIGNED' or 'PROJECT_LEAD').
   */
  async function updateProjectSettings(projectKey, settings) {
    const res = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  async function getProjectBoards(projectKey) {
    const res = await jiraFetch(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=10`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    return (data.values || []).map((b) => ({ id: b.id, name: b.name, type: b.type }));
  }

  /**
   * Get all roles for a project. Returns { roleName: roleId } map.
   */
  async function getProjectRoles(projectKey) {
    const res = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}/role`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    const data = await res.json();
    const roles = {};
    for (const [name, url] of Object.entries(data)) {
      const match = url.match(/\/(\d+)$/);
      if (match) roles[name] = match[1];
    }
    return roles;
  }

  /**
   * Add a user (by accountId) to a project role.
   */
  async function addUserToProjectRole(projectKey, roleId, accountId) {
    const res = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}/role/${roleId}`, {
      method: 'POST',
      body: JSON.stringify({ user: [accountId] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  /**
   * Add a user to a Jira Cloud project's team via the internal people/team endpoint.
   * This grants actual project access and assignability (works on simplified/next-gen projects).
   */
  async function addUserToProjectTeam(projectKey, accountId) {
    // Try the v2 project actors endpoint (grants project-level permissions)
    const res = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}/role/10002`, {
      method: 'POST',
      body: JSON.stringify({ user: [accountId] }),
    });

    // Also try to add via the project properties to ensure the user is a team member
    // On next-gen/team-managed projects, the permission model is different
    try {
      await jiraFetch(`/rest/api/2/user/application?applicationKey=jira-software&accountId=${accountId}`, {
        method: 'POST',
      });
    } catch (_) {
      // This endpoint may not exist on all instances — ignore errors
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseJiraError(err, res.status));
    }
    return res.json();
  }

  /**
   * Invite users to Jira Cloud.
   * Tries multiple approaches in order:
   * 1. Bulk invite via POST /rest/api/3/user/bulk (Jira Cloud sends invitation emails)
   * 2. Individual invite via POST /rest/api/3/user (requires admin, creates managed account)
   *
   * @param {string[]} emailAddresses - Array of email addresses to invite
   * @returns {Promise<Array>} Array of { email, accountId?, status, error? }
   */
  async function inviteUsersToJira(emailAddresses) {
    if (!emailAddresses || emailAddresses.length === 0) return [];

    // Try bulk invite first (sends invitation emails — works on most Jira Cloud plans)
    try {
      const bulkRes = await jiraFetch('/rest/api/3/user/bulk', {
        method: 'POST',
        body: JSON.stringify({ emailAddresses }),
      });
      if (bulkRes.ok) {
        console.log(`[Jira] Bulk invite sent for ${emailAddresses.length} email(s)`);
        // Bulk invite doesn't return accountIds — we'll re-search after a delay
        return emailAddresses.map(email => ({ email, status: 'invited', displayName: email }));
      }
      const bulkErr = await bulkRes.json().catch(() => ({}));
      console.warn(`[Jira] Bulk invite failed (${bulkRes.status}): ${parseJiraError(bulkErr, bulkRes.status)} — falling back to individual invites`);
    } catch (err) {
      console.warn(`[Jira] Bulk invite error: ${err.message} — falling back to individual invites`);
    }

    // Fallback: individual invite via user creation API (requires admin)
    const results = [];
    for (const email of emailAddresses) {
      try {
        const res = await jiraFetch('/rest/api/3/user', {
          method: 'POST',
          body: JSON.stringify({
            emailAddress: email,
            products: ['jira-software'],
          }),
        });

        if (res.ok) {
          const user = await res.json();
          results.push({ email, accountId: user.accountId, status: 'invited', displayName: user.displayName || email });
        } else if (res.status === 409) {
          results.push({ email, status: 'already_exists' });
        } else {
          const err = await res.json().catch(() => ({}));
          results.push({ email, status: 'failed', error: parseJiraError(err, res.status) });
        }
      } catch (err) {
        results.push({ email, status: 'failed', error: err.message });
      }
    }

    return results;
  }

  return {
    domain,
    getSprints,
    getSprintDetails,
    getSprintIssues,
    getProjectIssues,
    getBurndownData,
    getIssueTransitions,
    transitionIssue,
    createEpic,
    createStory,
    testConnection,
    getBoards,
    createSprint,
    startSprint,
    closeSprint,
    moveIssueToSprint,
    assignIssue,
    updateStoryPoints,
    searchUser,
    searchAssignableUser,
    getMyself,
    createProject,
    updateProjectLead,
    updateProjectSettings,
    getProjectBoards,
    getProjectRoles,
    addUserToProjectRole,
    addUserToProjectTeam,
    inviteUsersToJira,
  };
}
