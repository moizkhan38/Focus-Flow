import { useState, useMemo, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';

export function useSprintCompletion({ issues, sprint, project }) {
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionResult, setCompletionResult] = useState(null);
  const [completionError, setCompletionError] = useState(null);

  const allDone = useMemo(() => {
    if (!issues || issues.length === 0) return false;
    return issues.every(i => {
      const s = (i.status || '').toLowerCase();
      return s.includes('done') || s.includes('closed') || s.includes('resolved');
    });
  }, [issues]);

  const sprintClosed = sprint?.state === 'closed';

  const showCompletionBanner = allDone && !completionDismissed && !sprintClosed && !completionResult;

  const completeSprint = useCallback(async () => {
    if (!project?.jiraSprintId || !project?.jiraBoardId) return null;
    setCompleting(true);
    setCompletionError(null);
    try {
      const res = await apiFetch(`/api/jira/sprint/${project.jiraSprintId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: project.jiraBoardId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Sprint completion failed');
      }
      const data = await res.json();
      setCompletionResult(data);
      return data;
    } catch (err) {
      setCompletionError(err.message);
      return null;
    } finally {
      setCompleting(false);
    }
  }, [project?.jiraSprintId, project?.jiraBoardId]);

  return {
    allDone,
    sprintClosed,
    showCompletionBanner,
    showCompletionModal,
    setShowCompletionModal,
    completionDismissed,
    setCompletionDismissed,
    completing,
    completionResult,
    completionError,
    completeSprint,
  };
}
