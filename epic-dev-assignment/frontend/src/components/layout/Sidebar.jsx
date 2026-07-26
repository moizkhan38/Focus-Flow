import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useClerk, OrganizationSwitcher } from '@clerk/clerk-react';
import {
  FolderKanban,
  PlusCircle,
  Users,
  LayoutDashboard,
  LogOut,
  Plug,
  Menu,
  X,
} from 'lucide-react';
import LogoMark, { Wordmark } from '../shared/Logo';

const navSections = [
  {
    label: 'AI Workflow',
    items: [
      { to: '/projects', label: 'Projects', icon: FolderKanban, end: true },
      { to: '/projects/new', label: 'New Project', icon: PlusCircle },
      { to: '/developers', label: 'Developers', icon: Users },
    ],
  },
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/settings', label: 'Integrations', icon: Plug },
    ],
  },
];

function NavItem({ to, label, icon: Icon, end }) {
  const reduceMotion = useReducedMotion();

  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'text-blue-700 dark:text-blue-300'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* The active pill is a single shared element: framer animates it
              between nav items via layoutId instead of popping it on/off. */}
          {isActive && (
            <motion.span
              layoutId="sidebar-active-pill"
              className="absolute inset-0 rounded-lg bg-blue-50 dark:bg-blue-900/30"
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 420, damping: 34 }
              }
            />
          )}
          <Icon className="relative h-4 w-4 flex-shrink-0 transition-transform duration-200 group-hover:scale-110" />
          <span className="relative transition-transform duration-200 group-hover:translate-x-0.5">
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar() {
  const { signOut } = useClerk();
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  // Mobile only: the sidebar is a slide-in drawer below `lg`. From `lg` up it is
  // a static column exactly as before — desktop layout is untouched.
  const [open, setOpen] = useState(false);

  // Close the drawer whenever the route changes so a tap on a nav item doesn't
  // leave the overlay covering the page it just navigated to.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Don't let the page behind the drawer scroll while it's open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      {/* Mobile top bar — the only chrome visible until the drawer is opened */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b border-gray-200 bg-white px-3 dark:border-white/10 dark:bg-gray-900 lg:hidden">
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          whileTap={reduceMotion ? undefined : { scale: 0.88 }}
          className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 active:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
        >
          <Menu className="h-5 w-5" />
        </motion.button>
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark className="h-7 w-7" />
          <Wordmark className="truncate text-sm font-semibold" />
        </div>
      </div>

      {/* Backdrop — fades rather than popping in */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* The drawer slides via CSS transform, not framer: an inline transform
          would beat `lg:translate-x-0` and hide the static desktop column. */}
      <aside
        className={`h-viewport fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-shrink-0 flex-col border-r border-gray-200 bg-white transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none dark:border-white/10 dark:bg-gray-900 lg:static lg:z-auto lg:w-56 lg:max-w-none lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-2xl lg:shadow-none' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-gray-200 dark:border-white/10 px-4">
          <LogoMark className="h-7 w-7" />
          <Wordmark className="text-sm font-semibold" />
          <motion.button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            whileTap={reduceMotion ? undefined : { scale: 0.88, rotate: 90 }}
            className="ml-auto rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/5 lg:hidden"
          >
            <X className="h-4 w-4" />
          </motion.button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navSections.map((section) => (
            <div key={section.label} className="mb-5">
              <p className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavItem key={item.to} {...item} />
                ))}
              </div>
            </div>
          ))}

        </nav>

        {/* Organization + Logout. flex-shrink-0 so a long nav list can never
            squeeze these out — the nav above scrolls instead. pb accounts for
            the iPhone home indicator when running as an installed PWA. */}
        <div
          className="flex-shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-2"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          <div className="px-1">
            <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/projects" />
          </div>
          <motion.button
            onClick={() => signOut()}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
          >
            <LogOut className="h-4 w-4 flex-shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" />
            Logout
          </motion.button>
        </div>
      </aside>
    </>
  );
}
