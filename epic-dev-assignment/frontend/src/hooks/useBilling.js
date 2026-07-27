import useSWR from 'swr';
import { useOrganization } from '@clerk/clerk-react';
import { apiJson } from '../lib/api';

// The org's plan, features and metered usage.
//
// Read from OUR backend rather than from Clerk's session claims directly, for two
// reasons: usage counters (AI generations this month, projects used) only exist
// here, and the backend already falls back to Clerk's Billing API when a session
// token predates the checkout — so a just-upgraded org sees the change without
// waiting for a token refresh.
//
// This is display state, not enforcement. Every gated route is guarded on the
// server; hiding a button is a courtesy, not a control.

const fetcher = (path) => apiJson(path);

export function useBilling() {
  const { organization } = useOrganization();

  const { data, error, isLoading, mutate } = useSWR(
    organization ? `/api/billing/status?org=${organization.id}` : null,
    () => fetcher('/api/billing/status'),
    { revalidateOnFocus: true, dedupingInterval: 30_000 }
  );

  // Called on return from checkout: clears the backend's 60s entitlement cache
  // so the new plan is visible at once instead of a minute later.
  const refresh = async () => {
    try {
      const fresh = await apiJson('/api/billing/refresh', { method: 'POST' });
      await mutate(fresh, { revalidate: false });
      return fresh;
    } catch {
      return mutate();
    }
  };

  const features = data?.features || {};
  const usage = data?.usage || {};

  return {
    plan: data?.plan || 'free',
    isPaid: !!data?.isPaid,
    features,
    usage,
    isLoading,
    error,
    refresh,
    mutate,
    /** has('jira_sync') — false while loading, so nothing paid flashes into view. */
    has: (feature) => !!features[feature],
    /** Remaining allowance for a metered thing; null when unlimited. */
    remaining: (key) => {
      const u = usage[key];
      if (!u || u.limit == null) return null;
      return Math.max(0, u.limit - u.used);
    },
    atLimit: (key) => {
      const u = usage[key];
      return !!u && u.limit != null && u.used >= u.limit;
    },
  };
}

export const FEATURES = {
  JIRA_SYNC: 'jira_sync',
  STANDUP_BOT: 'standup_bot',
  UNLIMITED_PROJECTS: 'unlimited_projects',
  UNLIMITED_AI: 'unlimited_ai',
};
