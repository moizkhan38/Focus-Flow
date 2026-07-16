import { Link } from 'react-router-dom';
import { Plug, ArrowRight } from 'lucide-react';

// Shown wherever a surface needs an integration the org hasn't connected yet
// (backend answers 412 *_NOT_CONNECTED). This is a normal state for a new
// organization — not an error — so it reads as a next step, not a failure.

const COPY = {
  jira: {
    title: 'Connect Jira to see sprint data',
    body: 'Sprints, boards, burndown charts and syncing all read from your organization’s own Jira site.',
  },
  github: {
    title: 'Connect GitHub to analyze developers',
    body: 'Developer expertise and experience are detected from commit history in your organization’s repositories.',
  },
};

export default function NotConnected({ provider = 'jira', compact = false }) {
  const copy = COPY[provider] || COPY.jira;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-default bg-card-theme p-4">
        <Plug className="w-4 h-4 text-blue-600 shrink-0" />
        <p className="text-sm text-muted flex-1 min-w-[12rem]">{copy.title}</p>
        <Link
          to="/settings"
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          Connect <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-default bg-card-theme px-6 py-16 text-center">
      <div className="p-3 rounded-full bg-blue-50 mb-4">
        <Plug className="w-6 h-6 text-blue-600" />
      </div>
      <h3 className="text-lg font-semibold text-heading">{copy.title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted">{copy.body}</p>
      <Link
        to="/settings"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
      >
        Go to Integrations <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
