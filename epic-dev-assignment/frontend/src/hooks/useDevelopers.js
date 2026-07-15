import { useCallback } from 'react';
import useSWR from 'swr';
import { apiFetch } from '../lib/api.js';

// Server-backed developer roster (Phase 1, step 1.7) — was localStorage.
// SWR keyed on the endpoint so every mounted instance shares one cache and
// mutations converge across pages. Rows are org-scoped by the backend.
//
// Each developer: { username, email, jiraUsername, avatar, primary_expertise,
//                   experience_level, top_skills, analysis, availability, addedAt }
// `email` is the developer's Jira account email — used for inviting them to Jira
// and for the explicit lookup when assigning issues. `jiraUsername` is the legacy
// display-name fallback; new code should prefer `email`.

const KEY = '/api/db/developers';

function toClient(row) {
  return {
    username: row.username,
    email: row.email || '',
    jiraUsername: row.jira_username || '',
    avatar: row.avatar_url || `https://avatars.githubusercontent.com/${row.username}`,
    avatar_url: row.avatar_url || `https://avatars.githubusercontent.com/${row.username}`,
    primary_expertise: row.primary_expertise || null,
    experience_level: row.experience_level || null,
    top_skills: row.top_skills || [],
    analysis: row.analysis || null,
    availability: row.availability || null,
    addedAt: row.added_at,
  };
}

function toRow(dev) {
  return {
    username: dev.username,
    email: dev.email || null,
    jira_username: dev.jiraUsername || null,
    avatar_url: dev.avatar || dev.avatar_url || null,
    primary_expertise: dev.primary_expertise || null,
    experience_level: dev.experience_level || null,
    top_skills: dev.top_skills || null,
    analysis: dev.analysis || null,
    availability: dev.availability || null,
  };
}

async function fetcher(path) {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map(toClient);
}

async function upsertOnServer(dev) {
  const res = await apiFetch(KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toRow(dev)),
  });
  if (!res.ok) throw new Error(`developer save failed: HTTP ${res.status}`);
}

function mergeInto(list, dev) {
  const idx = list.findIndex((d) => d.username === dev.username);
  if (idx >= 0) {
    const merged = {
      ...list[idx],
      ...dev,
      // keep an already-set email/jiraUsername over incoming blanks
      email: list[idx].email || dev.email || '',
      jiraUsername: list[idx].jiraUsername || dev.jiraUsername || '',
    };
    const next = [...list];
    next[idx] = merged;
    return { next, saved: merged };
  }
  const added = {
    ...dev,
    email: dev.email || '',
    jiraUsername: dev.jiraUsername || '',
    addedAt: new Date().toISOString(),
  };
  return { next: [...list, added], saved: added };
}

export function useDevelopers() {
  const { data, mutate, isLoading, error } = useSWR(KEY, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const developers = data || [];
  const isLoaded = !isLoading && !error;

  // Optimistic local update + background save; revalidate afterwards so all
  // mounted instances converge on the server state.
  const applyAndSave = useCallback((next, toSave) => {
    mutate(next, { revalidate: false });
    Promise.all(toSave.map(upsertOnServer))
      .catch((err) => console.error('[Developers]', err))
      .finally(() => mutate());
  }, [mutate]);

  const addDeveloper = useCallback((dev) => {
    const { next, saved } = mergeInto(developers, dev);
    applyAndSave(next, [saved]);
  }, [developers, applyAndSave]);

  const addDevelopers = useCallback((devs) => {
    let next = developers;
    const savedAll = [];
    for (const dev of devs) {
      const r = mergeInto(next, dev);
      next = r.next;
      savedAll.push(r.saved);
    }
    applyAndSave(next, savedAll);
  }, [developers, applyAndSave]);

  const updateField = useCallback((username, updater) => {
    const target = developers.find((d) => d.username === username);
    if (!target) return;
    const updated = updater(target);
    applyAndSave(
      developers.map((d) => (d.username === username ? updated : d)),
      [updated]
    );
  }, [developers, applyAndSave]);

  const updateJiraUsername = useCallback((username, jiraUsername) => {
    updateField(username, (d) => ({ ...d, jiraUsername }));
  }, [updateField]);

  const updateEmail = useCallback((username, email) => {
    updateField(username, (d) => ({ ...d, email }));
  }, [updateField]);

  const updateAvailability = useCallback((username, availability) => {
    // availability: { status: 'available'|'busy'|'on-leave', capacity: 0-100 }
    updateField(username, (d) => ({ ...d, availability: { ...d.availability, ...availability } }));
  }, [updateField]);

  const removeDeveloper = useCallback((username) => {
    mutate(developers.filter((d) => d.username !== username), { revalidate: false });
    apiFetch(`${KEY}/${encodeURIComponent(username)}`, { method: 'DELETE' })
      .then((res) => {
        if (!res.ok && res.status !== 404) console.error(`[Developers] delete failed: ${res.status}`);
      })
      .catch((err) => console.error('[Developers] delete failed:', err))
      .finally(() => mutate());
  }, [developers, mutate]);

  const getDeveloper = useCallback(
    (username) => developers.find((d) => d.username === username) || null,
    [developers]
  );

  return {
    developers,
    isLoaded,
    addDeveloper,
    addDevelopers,
    updateJiraUsername,
    updateEmail,
    updateAvailability,
    removeDeveloper,
    getDeveloper,
  };
}
