import useSWR from 'swr';
import { useOrganization } from '@clerk/clerk-react';
import { apiJson } from '../lib/api.js';

// Per-org integration status (Phase 2). Shape from GET /api/integrations:
//   { jira:   { connected, domain?, email? },
//     github: { connected, login?, tokenSuffix? } }
// Never contains token material — tokens are write-only.

const fetcher = (url) => apiJson(url);

export function useIntegrations() {
  const { organization, membership } = useOrganization();

  // Keyed by org so switching orgs refetches instead of showing the old org's status.
  const { data, error, isLoading, mutate } = useSWR(
    organization ? `/api/integrations?org=${organization.id}` : null,
    () => fetcher('/api/integrations'),
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );

  const status = data || { jira: { connected: false }, github: { connected: false } };

  return {
    jira: status.jira,
    github: status.github,
    // Only org admins may change integrations (backend enforces; this drives the UI).
    isAdmin: membership?.role === 'org:admin',
    error,
    isLoading,
    mutate,
  };
}
