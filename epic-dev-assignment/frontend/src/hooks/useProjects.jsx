import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { apiFetch } from '../lib/api.js';

// Server-backed projects store (Phase 1, step 1.7).
//
// The full client-side project object (epics, stories, assignments, analyzed
// developers, jiraProgress, ...) is persisted verbatim in the `raw` JSONB column;
// flat columns (name/status/jira_project_key/...) are derived metadata the server
// needs for queries (e.g. socket room authorization).
//
// Interface is IDENTICAL to the old localStorage version: mutators stay
// synchronous + optimistic; persistence happens in the background (debounced per
// project so wizard click-bursts coalesce into one write). Data is scoped to the
// active Clerk organization and refetched when it changes — nothing tenant-owned
// lives in localStorage anymore (closes the cross-account leak finding).

const LEGACY_KEY = 'focus-flow-projects';
const SAVE_DEBOUNCE_MS = 800;

function toClient(row) {
  // `raw` is the source of truth; id from the column for safety.
  return { ...(row.raw || {}), id: row.id };
}

function toRow(p) {
  return {
    id: p.id,
    name: p.name || 'Untitled Project',
    description: p.description || null,
    status: p.status || 'draft',
    jira_project_key: p.jiraProjectKey || null,
    jira_board_id: p.jiraBoardId ?? null,
    jira_sprint_id: p.jiraSprintId ?? null,
    deadline: p.deadline || null,
    sprint_count: p.sprintCount || 1,
    raw: p,
  };
}

function readLegacy() {
  try {
    const stored = localStorage.getItem(LEGACY_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const ProjectsContext = createContext(null);

export function ProjectsProvider({ children }) {
  const { isSignedIn, orgId } = useAuth();
  const [projects, setProjects] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const saveTimers = useRef({});

  // ── Load from the server; reload on sign-in / org switch ──────────────────
  const refresh = useCallback(async () => {
    if (!isSignedIn || !orgId) {
      setProjects([]);
      setIsLoaded(true);
      return;
    }
    try {
      const res = await apiFetch('/api/db/projects');
      if (res.ok) {
        const rows = await res.json();
        setProjects(rows.map(toClient));
      } else {
        console.error('[Projects] load failed:', res.status);
      }
    } catch (err) {
      console.error('[Projects] load failed:', err);
    }
    setIsLoaded(true);
  }, [isSignedIn, orgId]);

  useEffect(() => {
    setIsLoaded(false);
    setProjects([]); // never show another org's (or a signed-out) state
    refresh();
  }, [refresh]);

  // ── Persistence ────────────────────────────────────────────────────────────
  const saveToServer = useCallback(async (project) => {
    try {
      const res = await apiFetch('/api/db/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toRow(project)),
      });
      if (!res.ok) console.error(`[Projects] save failed for ${project.id}: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[Projects] save failed for ${project.id}:`, err);
    }
  }, []);

  const scheduleSave = useCallback((project) => {
    clearTimeout(saveTimers.current[project.id]);
    saveTimers.current[project.id] = setTimeout(() => saveToServer(project), SAVE_DEBOUNCE_MS);
  }, [saveToServer]);

  // Apply an updater to one project: optimistic local state + background save.
  const applyChange = useCallback((projectId, updater, { immediate = false } = {}) => {
    const updated = projectsRef.current.map((p) => (p.id === projectId ? updater(p) : p));
    setProjects(updated);
    const changed = updated.find((p) => p.id === projectId);
    if (!changed) return;
    if (immediate) {
      clearTimeout(saveTimers.current[projectId]);
      saveToServer(changed);
    } else {
      scheduleSave(changed);
    }
  }, [saveToServer, scheduleSave]);

  // ── Public interface (unchanged from the localStorage era) ────────────────
  const addProject = useCallback((project) => {
    const updated = [project, ...projectsRef.current.filter((p) => p.id !== project.id)];
    setProjects(updated);
    saveToServer(project);
  }, [saveToServer]);

  const getProject = useCallback(
    (id) => projectsRef.current.find((p) => p.id === id) || null,
    []
  );

  const updateProject = useCallback((id, updates) => {
    applyChange(id, (p) => ({ ...p, ...updates }), { immediate: true });
  }, [applyChange]);

  const setEpics = useCallback((projectId, epics) => {
    applyChange(projectId, (p) => ({ ...p, epics, status: 'epics-ready' }));
  }, [applyChange]);

  const addStoriesToEpic = useCallback((projectId, epicId, stories) => {
    applyChange(projectId, (p) => {
      const updatedEpics = p.epics.map((e) => (e.id === epicId ? { ...e, stories } : e));
      const allHaveStories = updatedEpics.every((e) => e.stories.length > 0);
      return { ...p, epics: updatedEpics, status: allHaveStories ? 'stories-ready' : p.status };
    });
  }, [applyChange]);

  const updateEpicStatus = useCallback((projectId, epicId, status) => {
    applyChange(projectId, (p) => ({
      ...p,
      epics: p.epics.map((e) => (e.id === epicId ? { ...e, status } : e)),
    }));
  }, [applyChange]);

  const updateStoryStatus = useCallback((projectId, epicId, storyId, status) => {
    applyChange(projectId, (p) => ({
      ...p,
      epics: p.epics.map((e) =>
        e.id === epicId
          ? { ...e, stories: e.stories.map((s) => (s.id === storyId ? { ...s, status } : s)) }
          : e
      ),
    }));
  }, [applyChange]);

  const updateEpic = useCallback((projectId, epicId, updates) => {
    applyChange(projectId, (p) => ({
      ...p,
      epics: p.epics.map((e) => (e.id === epicId ? { ...e, ...updates } : e)),
    }));
  }, [applyChange]);

  const updateStory = useCallback((projectId, epicId, storyId, updates) => {
    applyChange(projectId, (p) => ({
      ...p,
      epics: p.epics.map((e) =>
        e.id === epicId
          ? { ...e, stories: e.stories.map((s) => (s.id === storyId ? { ...s, ...updates } : s)) }
          : e
      ),
    }));
  }, [applyChange]);

  const bulkUpdateStatus = useCallback((projectId, status) => {
    applyChange(projectId, (p) => ({
      ...p,
      epics: p.epics.map((e) => ({
        ...e,
        status,
        stories: e.stories.map((s) => ({ ...s, status })),
      })),
    }));
  }, [applyChange]);

  const setAssignments = useCallback((projectId, assignments, analyzedDevelopers) => {
    applyChange(
      projectId,
      (p) => ({ ...p, assignments, analyzedDevelopers, status: 'assigned' }),
      { immediate: true }
    );
  }, [applyChange]);

  const deleteProject = useCallback((projectId) => {
    clearTimeout(saveTimers.current[projectId]);
    setProjects(projectsRef.current.filter((p) => p.id !== projectId));
    apiFetch(`/api/db/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
      .then((res) => {
        if (!res.ok && res.status !== 404) console.error(`[Projects] delete failed: ${res.status}`);
      })
      .catch((err) => console.error('[Projects] delete failed:', err));
  }, []);

  const syncJiraProgress = useCallback((projectId, jiraIssues) => {
    if (!jiraIssues || jiraIssues.length === 0) return;
    let todo = 0, inProgress = 0, done = 0, donePoints = 0, totalPoints = 0;
    jiraIssues.forEach(i => {
      const s = (i.status || '').toLowerCase();
      const pts = i.storyPoints || 0;
      totalPoints += pts;
      if (s.includes('done') || s.includes('closed') || s.includes('resolved')) { done++; donePoints += pts; }
      else if (s.includes('progress') || s.includes('review')) inProgress++;
      else todo++;
    });
    applyChange(projectId, (p) => ({
      ...p,
      jiraProgress: {
        total: jiraIssues.length, todo, inProgress, done, donePoints, totalPoints,
        lastSynced: Date.now(),
      },
    }));
  }, [applyChange]);

  // ── One-time import of pre-1.7 localStorage projects ──────────────────────
  const legacyProjects = readLegacy();
  const hasLegacyData = legacyProjects.length > 0;

  const importLegacyProjects = useCallback(async () => {
    const legacy = readLegacy();
    let imported = 0;
    for (const p of legacy) {
      if (!p?.id) continue;
      // eslint-disable-next-line no-await-in-loop
      await saveToServer(p);
      imported++;
    }
    // Park the old data under a .migrated key instead of destroying it.
    try {
      localStorage.setItem(`${LEGACY_KEY}.migrated`, localStorage.getItem(LEGACY_KEY) || '[]');
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* quota — non-fatal */ }
    await refresh();
    return imported;
  }, [saveToServer, refresh]);

  const value = {
    projects,
    isLoaded,
    addProject,
    getProject,
    updateProject,
    setEpics,
    addStoriesToEpic,
    updateEpicStatus,
    updateStoryStatus,
    updateEpic,
    updateStory,
    bulkUpdateStatus,
    setAssignments,
    deleteProject,
    syncJiraProgress,
    // 1.7 migration helpers
    hasLegacyData,
    importLegacyProjects,
    refreshProjects: refresh,
  };

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects() {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error('useProjects must be used within ProjectsProvider');
  return ctx;
}
