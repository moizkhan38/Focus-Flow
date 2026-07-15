import { useCallback } from 'react';
import useSWR from 'swr';
import { apiFetch } from '../lib/api.js';

// Server-backed sprint retrospectives (Phase 1, step 1.7) — was localStorage.
// Client shape (unchanged): { [projectId]: { wentWell, toImprove, actionItems, createdAt, updatedAt } }
// Server rows: { project_id, went_well, went_wrong, actions, created_at } — the
// newest row per project wins (rows are ordered created_at DESC by the API).

const KEY = '/api/db/retrospectives';

async function fetcher(path) {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  const byProject = {};
  for (const row of rows) {
    if (!row.project_id || byProject[row.project_id]) continue; // first = newest
    byProject[row.project_id] = {
      wentWell: row.went_well || [],
      toImprove: row.went_wrong || [],
      actionItems: row.actions || [],
      createdAt: row.created_at,
      updatedAt: row.created_at,
    };
  }
  return byProject;
}

export function useRetro() {
  const { data, mutate } = useSWR(KEY, fetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
  const retros = data || {};

  const getRetro = useCallback(
    (projectId) => retros[projectId] || null,
    [retros]
  );

  const saveRetro = useCallback((projectId, retro) => {
    const entry = {
      ...retro,
      updatedAt: new Date().toISOString(),
      createdAt: retros[projectId]?.createdAt || new Date().toISOString(),
    };
    mutate({ ...retros, [projectId]: entry }, { revalidate: false });
    apiFetch(KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        went_well: retro.wentWell || [],
        went_wrong: retro.toImprove || [],
        actions: retro.actionItems || [],
      }),
    })
      .then((res) => { if (!res.ok) console.error(`[Retro] save failed: ${res.status}`); })
      .catch((err) => console.error('[Retro] save failed:', err))
      .finally(() => mutate());
  }, [retros, mutate]);

  // Local-only removal (no DELETE endpoint; a newer save simply supersedes).
  const deleteRetro = useCallback((projectId) => {
    const next = { ...retros };
    delete next[projectId];
    mutate(next, { revalidate: false });
  }, [retros, mutate]);

  return { retros, getRetro, saveRetro, deleteRetro };
}
