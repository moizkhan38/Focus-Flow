// Shared entrance motion for the login / signup screens, so both pages stay in
// step. The logo, wordmark, tagline and the Clerk form fade up in sequence.
//
// Note these are plain objects rather than a hook: framer's `useReducedMotion`
// can't be called from a module scope. The distances here are small (10px) and
// the CSS `prefers-reduced-motion` block in index.css already collapses
// transition durations, so the effect degrades acceptably on its own.

export const authIntroItem = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

/** Spread onto the container: `<motion.div {...authIntro}>` */
export const authIntro = {
  initial: 'hidden',
  animate: 'show',
  variants: { hidden: {}, show: { transition: { staggerChildren: 0.08 } } },
};
