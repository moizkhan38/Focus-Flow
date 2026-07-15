import { useWorkflow } from '../../context/WorkflowContext';
import { useThemeContext } from '../../App';
import { OrganizationSwitcher, UserButton } from '@clerk/clerk-react';
import { Sparkles, Sun, Moon } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Header() {
  const { reset } = useWorkflow();
  const { isDark, toggleTheme } = useThemeContext();

  const handleReset = () => {
    if (confirm('Are you sure you want to start over? All progress will be lost.')) {
      reset();
    }
  };

  return (
    <header className="sticky top-0 z-50 backdrop-blur-2xl" style={{ background: 'var(--bg-overlay)' }}>
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--accent-cyan)] via-[var(--accent-purple)] to-[var(--accent-lime)] p-[1px]">
            <div className="w-full h-full rounded-[11px] flex items-center justify-center" style={{ background: 'var(--gradient-border-inner)' }}>
              <Sparkles className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            </div>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight leading-tight" style={{ color: 'var(--text-primary)' }}>
              Epic & Dev Assignment
            </h1>
            <p className="text-[11px] font-mono tracking-wide uppercase" style={{ color: 'var(--text-tertiary)' }}>
              AI-Powered Workflow
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/projects" />
          <UserButton />
          <motion.button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors duration-300"
            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-card)' }}
            whileTap={{ scale: 0.92 }}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <motion.div
              key={isDark ? 'moon' : 'sun'}
              initial={{ rotate: -30, opacity: 0, scale: 0.8 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: 30, opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </motion.div>
          </motion.button>
          <button
            onClick={handleReset}
            className="text-xs py-2 px-4 rounded-lg border border-transparent text-danger/70
                     hover:bg-danger/10 hover:border-danger/20 hover:text-danger transition-all duration-300"
          >
            Reset
          </button>
        </div>
      </div>
      <div className="divider-glow" />
    </header>
  );
}
