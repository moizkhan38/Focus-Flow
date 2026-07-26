import { useState } from 'react';
import { Zap } from 'lucide-react';

// The brand mark lives at /public/logo-mark.png — the infinity symbol on its
// own, cropped square. Referenced by absolute URL so it resolves from any
// route depth. Wordmark/tagline text stays as regular markup next to it.
//
// Falls back to the previous blue Zap badge if the file is missing, so the UI
// never renders a broken-image box.

/**
 * The Focus Flow mark. Size it with Tailwind via `className` (default 28px).
 * Decorative by default — the adjacent markup already reads "Focus Flow".
 */
export default function LogoMark({ className = 'h-7 w-7', alt = '' }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${className} flex flex-shrink-0 items-center justify-center rounded-lg bg-blue-600`}
        aria-hidden={alt ? undefined : 'true'}
      >
        <Zap className="h-1/2 w-1/2 text-white" />
      </div>
    );
  }

  return (
    <img
      src="/logo-mark.png"
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
      className={`${className} flex-shrink-0 object-contain`}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * "Focus Flow" in the two-tone brand colors from the logo artwork.
 * Size and weight come from the caller; only the colors live here.
 *
 * The navy is nearly black-on-black in dark mode, so "Focus" flips to white
 * there. "Flow" keeps its teal, which reads on both backgrounds.
 */
export function Wordmark({ className = '' }) {
  return (
    <span className={className}>
      <span className="text-brand-navy dark:text-white">Focus</span>{' '}
      <span className="text-brand-teal">Flow</span>
    </span>
  );
}
