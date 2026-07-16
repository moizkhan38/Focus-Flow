import useSWR from 'swr';
import { apiJson } from '../lib/api.js';

// Errors surface as ApiError, so consumers can branch on err.notConnected
// (412 JIRA_NOT_CONNECTED) and render a connect CTA instead of a red banner.
const fetcher = (url) => apiJson(url);

export function useSprints() {
  const { data, error, isLoading } = useSWR('/api/jira/sprints', fetcher, {
    dedupingInterval: 30000,
    shouldRetryOnError: false,
    onErrorRetry: () => {},  // Don't retry — Jira may not be configured
  });
  return { sprints: data, error, isLoading };
}

export function useSprintDetails(sprintId) {
  const { data, error, isLoading } = useSWR(
    sprintId ? `/api/jira/sprint/${sprintId}` : null,
    fetcher,
    { dedupingInterval: 30000 }
  );
  return { sprint: data, error, isLoading };
}

export function useSprintIssues(sprintId) {
  const { data, error, isLoading, mutate } = useSWR(
    sprintId ? `/api/jira/sprint/${sprintId}/issues` : null,
    fetcher,
    {
      refreshInterval: 10000,
      dedupingInterval: 5000,
      errorRetryCount: 5,
      errorRetryInterval: 3000,
      revalidateOnFocus: true,
    }
  );
  return { issues: data || [], error, isLoading, mutate };
}

export function useProjectIssues(projectKey) {
  const { data, error, isLoading, mutate } = useSWR(
    projectKey ? `/api/jira/project/${projectKey}/issues` : null,
    fetcher,
    {
      refreshInterval: 10000,
      dedupingInterval: 5000,
      errorRetryCount: 5,
      errorRetryInterval: 3000,
      revalidateOnFocus: true,
    }
  );
  return { issues: data || [], error, isLoading, mutate };
}

export function useBurndownData(sprintId) {
  const { data, error, isLoading } = useSWR(
    sprintId ? `/api/jira/sprint/${sprintId}/burndown` : null,
    fetcher,
    { refreshInterval: 60000 }
  );
  return { burndown: data || [], error, isLoading };
}

export function useBoardSprints(boardId) {
  const { data, error, isLoading, mutate } = useSWR(
    boardId ? `/api/jira/board/${boardId}/sprints` : null,
    fetcher,
    { dedupingInterval: 30000 }
  );
  return { sprints: data || [], error, isLoading, mutate };
}
