import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { WorkflowProvider, useWorkflow } from './context/WorkflowContext'
import { ProjectsProvider } from './hooks/useProjects'
import { NotificationsProvider } from './hooks/useNotifications'
import { AnimatePresence, motion } from 'framer-motion'
import { createContext, useContext, Component } from 'react'
import { useTheme } from './hooks/useTheme'
import NotificationToast from './components/shared/NotificationToast'
import { AlertTriangle, RefreshCw } from 'lucide-react'

// Layout & guard
import Header from './components/layout/Header'
import AuthGuard from './components/layout/AuthGuard'
import Sidebar from './components/layout/Sidebar'

// Workflow steps (unchanged)
import ProgressStepper from './components/shared/ProgressStepper'
import Step1_EpicGeneration from './components/steps/Step1_EpicGeneration'
import Step2_EpicApproval from './components/steps/Step2_EpicApproval'
import Step3_DeveloperAnalysis from './components/steps/Step3_DeveloperAnalysis'
import Step4_Assignment from './components/steps/Step4_Assignment'

// Pages
import Login from './pages/Login'
import Signup from './pages/Signup'
import ProjectsPage from './pages/projects/ProjectsPage'
import ProjectWizardPage from './pages/projects/ProjectWizardPage'
import ProjectDetailPage from './pages/projects/ProjectDetailPage'
import ProjectKanbanPage from './pages/projects/ProjectKanbanPage'
import VerifyPage from './pages/projects/VerifyPage'
import AssignPage from './pages/projects/AssignPage'
import DevelopersPage from './pages/DevelopersPage'
import Dashboard from './pages/jira/Dashboard'

// Theme context (kept for existing workflow compatibility)
const ThemeContext = createContext({ theme: 'light', toggleTheme: () => {}, isDark: false })
export const useThemeContext = () => useContext(ThemeContext)

// ─── Error Boundary ───────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('Application error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
              <AlertTriangle className="h-7 w-7 text-red-600" />
            </div>
            <h1 className="mb-2 text-lg font-semibold text-gray-900">Something went wrong</h1>
            <p className="mb-6 text-sm text-gray-500">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.href = '/projects'; }}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <RefreshCw className="h-4 w-4" />
              Reload App
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Existing 4-step workflow (unchanged) ──────────────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 16, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -12, filter: 'blur(4px)', transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } }
}

function StepContent() {
  const { currentStep } = useWorkflow()
  const steps = {
    1: <Step1_EpicGeneration />,
    2: <Step2_EpicApproval />,
    3: <Step3_DeveloperAnalysis />,
    4: <Step4_Assignment />
  }
  return (
    <AnimatePresence mode="wait">
      <motion.div key={currentStep} variants={pageVariants} initial="initial" animate="animate" exit="exit">
        {steps[currentStep]}
      </motion.div>
    </AnimatePresence>
  )
}

function WorkflowApp() {
  return (
    <WorkflowProvider>
      <div className="ambient-bg">
        <div className="ambient-orb ambient-orb-1" />
        <div className="ambient-orb ambient-orb-2" />
        <div className="ambient-orb ambient-orb-3" />
      </div>
      <div className="noise-overlay" />
      <div className="grid-overlay" />
      <div className="relative z-10 min-h-screen">
        <Header />
        <main className="max-w-7xl mx-auto px-6 py-8">
          <ProgressStepper />
          <div className="mt-10">
            <StepContent />
          </div>
        </main>
      </div>
    </WorkflowProvider>
  )
}

// ─── Sidebar layout for new pages ──────────────────────────────────────────
function SidebarLayout({ children }) {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      <Sidebar />
      <div className="flex-1 overflow-auto" style={{ overflowAnchor: 'none' }}>
        {children}
      </div>
    </div>
  )
}

// ─── Root App ──────────────────────────────────────────────────────────────
function App() {
  const themeState = useTheme()

  return (
    <ThemeContext.Provider value={themeState}>
      <ErrorBoundary>
        <ProjectsProvider>
        <NotificationsProvider>
        <BrowserRouter>
          <NotificationToast />
          <Routes>
            {/* Public — wildcard routes: Clerk's path routing renders sub-steps
                (verification, SSO callback) under these paths */}
            <Route path="/login/*" element={<Login />} />
            <Route path="/signup/*" element={<Signup />} />

            {/* Default: redirect to projects */}
            <Route path="/" element={<Navigate to="/projects" replace />} />

            {/* Existing 4-step wizard — completely unchanged */}
            <Route path="/wizard" element={
              <AuthGuard>
                <WorkflowApp />
              </AuthGuard>
            } />

            {/* Project management */}
            <Route path="/projects" element={
              <AuthGuard><SidebarLayout><ProjectsPage /></SidebarLayout></AuthGuard>
            } />
            <Route path="/projects/new" element={
              <AuthGuard><SidebarLayout><ProjectWizardPage /></SidebarLayout></AuthGuard>
            } />
            <Route path="/projects/:projectId" element={
              <AuthGuard><SidebarLayout><ProjectDetailPage /></SidebarLayout></AuthGuard>
            } />
            <Route path="/projects/:projectId/verify" element={
              <AuthGuard><SidebarLayout><VerifyPage /></SidebarLayout></AuthGuard>
            } />
            <Route path="/projects/:projectId/assign" element={
              <AuthGuard><SidebarLayout><AssignPage /></SidebarLayout></AuthGuard>
            } />
            <Route path="/projects/:projectId/kanban" element={
              <AuthGuard><SidebarLayout><ProjectKanbanPage /></SidebarLayout></AuthGuard>
            } />

            {/* Developers */}
            <Route path="/developers" element={
              <AuthGuard><SidebarLayout><DevelopersPage /></SidebarLayout></AuthGuard>
            } />

            {/* Jira monitoring */}
            <Route path="/dashboard" element={
              <AuthGuard><SidebarLayout><Dashboard /></SidebarLayout></AuthGuard>
            } />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        </BrowserRouter>
        </NotificationsProvider>
        </ProjectsProvider>
      </ErrorBoundary>
    </ThemeContext.Provider>
  )
}

export default App
