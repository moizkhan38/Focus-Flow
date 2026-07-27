import { Link } from 'react-router-dom';
import { Sparkles, Lock } from 'lucide-react';

// Shown where a paid feature would be. The point is that it names the specific
// thing that's unavailable and the specific plan that fixes it — a generic
// "upgrade to continue" wall makes people leave rather than buy.

export function UpgradeBanner({ message, feature }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center">
      <Lock className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message || 'This is available on a paid plan.'}</span>
      <Link
        to="/billing"
        state={{ feature }}
        className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
      >
        See plans
      </Link>
    </div>
  );
}

// Full-panel variant for a whole page or section that the plan doesn't include.
export default function UpgradePrompt({ title, message, feature }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-6 py-14 text-center dark:border-gray-700 dark:bg-gray-900/40">
      <div className="rounded-full bg-amber-100 p-3 text-amber-600">
        <Sparkles className="h-6 w-6" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-heading">{title || 'Available on a paid plan'}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          {message || 'Upgrade your organization to unlock this.'}
        </p>
      </div>
      <Link
        to="/billing"
        state={{ feature }}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700"
      >
        View plans
      </Link>
    </div>
  );
}
