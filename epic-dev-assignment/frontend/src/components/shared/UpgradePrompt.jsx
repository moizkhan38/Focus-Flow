import { Link } from 'react-router-dom';
import { Sparkles, Lock } from 'lucide-react';
import { useBilling } from '../../hooks/useBilling';

// Shown where a feature the org's plan doesn't cover would be.
//
// Wording is deliberately plan-NEUTRAL. With more than one paid tier, "this is a
// paid feature" is simply false for a Basic customer who is already paying — and
// telling a paying customer they need to start paying is the fastest way to make
// them doubt the product. The copy names their actual plan instead.

function useCta() {
  const { plan, isPaid } = useBilling();
  return {
    heading: isPaid
      ? `Not included in your ${plan} plan`
      : 'Available on a paid plan',
    cta: isPaid ? 'Compare plans' : 'See plans',
  };
}

export function UpgradeBanner({ message, feature }) {
  const { heading, cta } = useCta();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center">
      <Lock className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message || `${heading}.`}</span>
      <Link
        to="/billing"
        state={{ feature }}
        className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
      >
        {cta}
      </Link>
    </div>
  );
}

// Full-panel variant for a whole page or section that the plan doesn't include.
export default function UpgradePrompt({ title, message, feature }) {
  const { heading, cta } = useCta();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-6 py-14 text-center dark:border-gray-700 dark:bg-gray-900/40">
      <div className="rounded-full bg-amber-100 p-3 text-amber-600">
        <Sparkles className="h-6 w-6" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-heading">{title || heading}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          {message || 'Another plan covers this — compare what each one includes.'}
        </p>
      </div>
      <Link
        to="/billing"
        state={{ feature }}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700"
      >
        {cta}
      </Link>
    </div>
  );
}
