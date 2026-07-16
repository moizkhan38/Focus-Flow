import { NavLink } from 'react-router-dom';
import { useClerk, OrganizationSwitcher } from '@clerk/clerk-react';
import {
  FolderKanban,
  PlusCircle,
  Zap,
  Users,
  LayoutDashboard,
  LogOut,
  Plug,
} from 'lucide-react';

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

  return (
    <aside className="flex h-screen w-56 flex-shrink-0 flex-col border-r border-gray-200 bg-white dark:border-white/10 dark:bg-gray-900">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b border-gray-200 dark:border-white/10 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600">
          <Zap className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-semibold text-gray-900 dark:text-white">Focus Flow</span>
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
  );
}
