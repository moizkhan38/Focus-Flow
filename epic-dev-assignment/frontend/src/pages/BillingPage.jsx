import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { PricingTable, useOrganization } from '@clerk/clerk-react';
import { Sparkles, Check, Loader2, AlertCircle } from 'lucide-react';
import { useBilling, FEATURES } from '../hooks/useBilling';

// What each feature slug means in plain language. The Clerk dashboard holds the
// prices and plan names; this is only the "what you're using right now" panel
// above the pricing table.
const FEATURE_LABELS = {
  [FEATURES.JIRA_SYNC]: 'Jira sync, live boards and burndown',
  [FEATURES.STANDUP_BOT]: 'Slack standup bot',
  [FEATURES.UNLIMITED_PROJECTS]: 'Unlimited projects and team members',
  [FEATURES.UNLIMITED_AI]: 'Unlimited AI generation',
};

function UsageBar({ label, used, limit, suffix }) {
  const unlimited = limit == null;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const full = !unlimited && used >= limit;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-heading">{label}</span>
        <span className={full ? 'font-medium text-amber-600' : 'text-muted'}>
          {unlimited ? 'Unlimited' : `${used} / ${limit}${suffix ? ` ${suffix}` : ''}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-full rounded-full transition-all ${full ? 'bg-amber-500' : 'bg-teal-500'}`}
          style={{ width: unlimited ? '100%' : `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { organization } = useOrganization();
  const location = useLocation();
  const { plan, isPaid, features, usage, isLoading, error, refresh } = useBilling();

  // Clerk's checkout returns to this page. Entitlement is cached for a minute on
  // the backend, so refresh once on arrival — otherwise a successful upgrade
  // looks like it did nothing.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const highlighted = location.state?.feature;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-heading">Plan &amp; billing</h1>
        <p className="mt-1 text-sm text-muted">
          Subscriptions cover the whole of{' '}
          <span className="font-medium text-heading">{organization?.name || 'your organization'}</span> —
          every member is included, and only an admin can change the plan.
        </p>
      </header>

      {highlighted && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">{FEATURE_LABELS[highlighted] || 'That feature'}</span> isn&apos;t
            included in your current plan. It&apos;s unlocked by the paid plans below.
          </span>
        </div>
      )}

      {/* Current usage */}
      <section className="mb-10 rounded-2xl border border-default bg-card-theme p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-heading">Current plan</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              isPaid ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {isLoading ? '…' : plan}
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your usage…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Couldn&apos;t load your usage. Your plan is unaffected — try reloading.</span>
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <UsageBar
                label="Projects"
                used={usage.projects?.used ?? 0}
                limit={usage.projects?.limit}
              />
              <UsageBar
                label="Team members"
                used={usage.developers?.used ?? 0}
                limit={usage.developers?.limit}
              />
              <UsageBar
                label="AI generations"
                used={usage.aiGenerations?.used ?? 0}
                limit={usage.aiGenerations?.limit}
                suffix="this month"
              />
            </div>

            {usage.aiGenerations?.limit != null && (
              <p className="mt-3 text-xs text-subtle">
                AI allowance resets on {usage.aiGenerations.resetsOn}.
              </p>
            )}

            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {Object.entries(FEATURE_LABELS).map(([slug, label]) => (
                <li key={slug} className="flex items-center gap-2 text-sm">
                  <Check
                    className={`h-4 w-4 shrink-0 ${features[slug] ? 'text-teal-600' : 'text-gray-300'}`}
                  />
                  <span className={features[slug] ? 'text-heading' : 'text-subtle line-through'}>
                    {label}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Plans. Clerk renders these from the dashboard configuration and handles
          checkout, payment methods, proration and cancellation itself —
          forOrganizations bills the active org rather than the individual. */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-heading">Plans</h2>
        <PricingTable forOrganizations />
      </section>
    </div>
  );
}
