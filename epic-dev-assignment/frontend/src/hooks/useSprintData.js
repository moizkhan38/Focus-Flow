import useSWR from 'swr';
import { apiFetch } from '../lib/api.js';

async function fetcher(url) {
  const res = await apiFetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

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
