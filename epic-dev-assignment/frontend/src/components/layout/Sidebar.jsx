import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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
import LogoMark from '../shared/Logo';

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
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
        }`
      }
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {label}
    </NavLink>
  );
}

export default function Sidebar() {
  const { signOut } = useClerk();
  const { pathname } = useLocation();
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
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark className="h-7 w-7" />
          <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">Focus Flow</span>
        </div>
      </div>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-64 max-w-[85vw] flex-shrink-0 flex-col border-r border-gray-200 bg-white transition-transform duration-200 dark:border-white/10 dark:bg-gray-900 lg:static lg:z-auto lg:w-56 lg:max-w-none lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 border-b border-gray-200 dark:border-white/10 px-4">
          <LogoMark className="h-7 w-7" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Focus Flow</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            className="ml-auto rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
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

        {/* Organization + Logout */}
        <div className="border-t border-gray-200 dark:border-white/10 p-3 space-y-2">
          <div className="px-1">
            <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/projects" />
          </div>
          <button
            onClick={() => signOut()}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
          >
            <LogOut className="h-4 w-4 flex-shrink-0" />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
