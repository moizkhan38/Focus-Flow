import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../lib/api.js';
import { useSprintIssues, useProjectIssues } from './useSprintData';
import { useRealtimeProject } from './useRealtime';

/**
 * Normalize any Jira status string to one of 3 kanban columns.
 * Uses includes() for robustness across custom Jira workflows.
 */
export function normalizeStatus(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'Done';
  if (s.includes('progress') || s.includes('review')) return 'In Progress';
  return 'To Do';
}

/**
 * Find the best Jira transition for a target kanban column.
 * Primary: match by statusCategory (reliable across all Jira instances).
 * Fallback: fuzzy name matching for edge cases.
 */
function findTransition(transitions, targetColumn) {
  // Primary: match by Jira statusCategory (stable)
  const byCategory = transitions.find(t => {
    if (targetColumn === 'Done') return t.toCategory === 'Done';
    if (targetColumn === 'In Progress') return t.toCategory === 'In Progress';
    return t.toCategory === 'To Do' || t.toCategory === 'New';
  });
  if (byCategory) return byCategory;

  // Fallback: fuzzy name match
  const target = targetColumn.toLowerCase();
  return transitions.find(t => {
    const name = t.name.toLowerCase();
    if (target === 'done') return name.includes('done') || name.includes('close') || name.includes('resolv');
    if (target === 'in progress') return name.includes('progress') || name.includes('start');
    return name.includes('todo') || name.includes('to do') || name.includes('backlog') || name.includes('open');
  });
}

/**
 * Consolidated kanban state + Jira sync hook.
 * Single source of truth for both mini and full kanban boards.
 *
 * Features:
 * - SWR data fetching with optimistic updates (pendingMoves)
 * - statusCategory-based transition matching
 * - Drag lock to prevent concurrent transitions on same card
 * - Error state management
 * - Auto-retry on empty initial load
 */
export function useKanbanSync(projectKey, sprintId) {
  // === Data Fetching ===
  const { issues: projectIssues, isLoading: projectLoading, error: projectError, mutate: mutateProjectIssues } = useProjectIssues(projectKey);
  const { issues: sprintIssuesRaw, isLoading: sprintLoading, error: sprintError, mutate: mutateSprintIssues } = useSprintIssues(sprintId);

  // Prefer project-level issues (all stories across all sprints)
  const rawIssues = projectIssues.length > 0 ? projectIssues : sprintIssuesRaw;
  const isLoading = projectKey ? projectLoading : sprintLoading;
  const connectionError = projectError || sprintError || null;
  const mutateIssues = projectKey ? mutateProjectIssues : mutateSprintIssues;

  // === Optimistic Updates ===
  const [pendingMoves, setPendingMoves] = useState({});
  const [syncingKey, setSyncingKey] = useState(null);
  const [moveError, setMoveError] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Track last successful data fetch
  useEffect(() => {
    if (rawIssues.length > 0) {
      setLastSyncedAt(new Date());
    }
  }, [rawIssues]);

  // Realtime: when any user moves/assigns a card in Jira, push a revalidate
  // so every viewer sees it instantly instead of waiting for the 10s SWR poll.
  useRealtimeProject(projectKey, useCallback(() => {
    mutateIssues();
  }, [mutateIssues]));

  // Auto-retry once if first fetch returns empty (Jira may still be indexing)
  useEffect(() => {
    if (projectKey && !isLoading && rawIssues.length === 0 && retryCount < 2) {
      const timer = setTimeout(() => {
        mutateIssues();
        setRetryCount(c => c + 1);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [projectKey, isLoading, rawIssues.length, retryCount, mutateIssues]);

  // Filter out epics when stories exist
  const storyIssues = useMemo(() => {
    const all = rawIssues || [];
    const nonEpics = all.filter(i => (i.issueType || '').toLowerCase() !== 'epic');
    return nonEpics.length > 0 ? nonEpics : all;
  }, [rawIssues]);

  // Merge SWR data with pending optimistic moves
  const mergedIssues = useMemo(() => {
    if (Object.keys(pendingMoves).length === 0) return storyIssues;
    return storyIssues.map(issue => {
      if (pendingMoves[issue.key]) {
        return { ...issue, status: pendingMoves[issue.key] };
      }
      return issue;
    });
  }, [storyIssues, pendingMoves]);

  // Build column data
  const columns = useMemo(() => {
    const cols = { 'To Do': [], 'In Progress': [], 'Done': [] };
    (mergedIssues || []).forEach(issue => {
      cols[normalizeStatus(issue.status)].push(issue);
    });
    return cols;
  }, [mergedIssues]);

  // === Derived data for filters ===
  const assignees = useMemo(() => {
    const names = new Set(storyIssues.map(i => i.assignee?.name || 'Unassigned'));
    return [...names].sort();
  }, [storyIssues]);

  const priorities = useMemo(() => {
    const names = new Set(storyIssues.map(i => i.priority).filter(Boolean));
    return [...names].sort();
  }, [storyIssues]);

  const issueTypes = useMemo(() => {
    const names = new Set(storyIssues.map(i => i.issueType).filter(Boolean));
    return [...names].sort();
  }, [storyIssues]);

  // === State flags ===
  const isEmpty = !isLoading && storyIssues.length === 0;
  const isNotSynced = !projectKey && !sprintId;
  const isDragLocked = syncingKey !== null;

  // === Transition Execution ===
  const moveIssue = useCallback(async (issueKey, targetColumn) => {
    setMoveError(null);

    // Drag lock: prevent moving the same card that's already in flight
    if (syncingKey === issueKey) return { success: false, error: 'Transition already in progress' };

    // Optimistic update
    setPendingMoves(prev => ({ ...prev, [issueKey]: targetColumn }));
    setSyncingKey(issueKey);

    try {
      const res = await apiFetch(`/api/jira/issue/${issueKey}`);
      if (!res.ok) throw new Error(`Failed to fetch transitions for ${issueKey}`);
      const { transitions } = await res.json();

      const transition = findTransition(transitions, targetColumn);
      if (!transition) {
        throw new Error(`No matching Jira transition to "${targetColumn}" found`);
      }

      const putRes = await apiFetch(`/api/jira/issue/${issueKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transitionId: transition.id }),
      });
      if (!putRes.ok) throw new Error(`Jira transition failed for ${issueKey}`);

      // Refresh from Jira, then clear pending move
      await mutateIssues();
      setPendingMoves(prev => {
        const next = { ...prev };
        delete next[issueKey];
        return next;
      });
      setLastSyncedAt(new Date());
      return { success: true };
    } catch (err) {
      // Revert optimistic update
      setPendingMoves(prev => {
        const next = { ...prev };
        delete next[issueKey];
        return next;
      });
      setMoveError({ issueKey, message: err.message });
      return { success: false, error: err.message };
    } finally {
      setSyncingKey(null);
    }
  }, [syncingKey, mutateIssues]);

  const clearMoveError = useCallback(() => setMoveError(null), []);

  const refresh = useCallback(() => {
    mutateIssues();
  }, [mutateIssues]);

  return {
    // Column data
    columns,
    mergedIssues,
    storyIssues,

    // Sync state
    syncingKey,
    moveError,
    clearMoveError,
    lastSyncedAt,
    isLoading,
    isEmpty,
    isNotSynced,
    connectionError,
    isDragLocked,

    // Actions
    moveIssue,
    refresh,

    // Filter helpers
    assignees,
    priorities,
    issueTypes,
  };
}
