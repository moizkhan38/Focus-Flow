import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useProjects } from '../../hooks/useProjects';
import { useTemplates } from '../../hooks/useTemplates';
import { PlusCircle, FolderKanban, Trash2, Clock, Users, BookOpen, CheckCircle2, AlertTriangle, ArrowRight, Zap, Calendar, Copy, FileStack, X, TrendingUp, Target, Layers, Trophy } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function MiniStat({ icon: Icon, value, label, color = 'gray' }) {
  const colorMap = {
    gray: 'text-gray-500 bg-gray-50',
    teal: 'text-teal-600 bg-teal-50',
    emerald: 'text-emerald-600 bg-emerald-50',
    blue: 'text-blue-600 bg-blue-50',
    amber: 'text-amber-600 bg-amber-50',
    purple: 'text-purple-600 bg-purple-50',
  };
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className={`rounded-lg p-1.5 ${colorMap[color]}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div>
        <p className="text-sm font-bold text-gray-900">{value}</p>
        <p className="text-[10px] text-gray-400">{label}</p>
      </div>
    </div>
  );
}

const statusConfig = {
  'epics-ready': { label: 'Epics Ready', color: 'bg-blue-100 text-blue-700', icon: BookOpen, step: 1 },
  'stories-ready': { label: 'Stories Ready', color: 'bg-purple-100 text-purple-700', icon: BookOpen, step: 2 },
  assigned: { label: 'Assigned', color: 'bg-amber-100 text-amber-700', icon: Users, step: 3 },
  synced: { label: 'Synced to Jira', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2, step: 4 },
  completed: { label: 'Completed', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2, step: 5 },
};

function getProjectProgress(project) {
  const totalEpics = project.epics?.length || 0;
  const totalStories = project.epics?.reduce((s, e) => s + (e.stories?.length || 0), 0) || 0;
  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;
  const approvedEpics = project.epics?.filter(e => e.status === 'approved').length || 0;
  const devCount = project.analyzedDevelopers?.length || project.assignments?.length || 0;
  const assignmentCount = project.assignments?.length || 0;

  // Completed projects always show 100%
  if (project.status === 'completed') {
    const jp = project.jiraProgress;
    return {
      totalEpics, totalStories, totalPoints, approvedEpics,
      doneStories: jp?.done || totalStories,
      donePoints: jp?.donePoints || totalPoints,
      inProgress: 0, todo: 0,
      jiraTotal: jp?.total || totalStories,
      jiraTotalPoints: jp?.totalPoints || totalPoints,
      devCount, assignmentCount, progressPct: 100,
    };
  }

  // For synced projects with Jira progress data, use live stats
  const jp = project.jiraProgress;
  if (project.status === 'synced' && jp && jp.total > 0) {
    const progressPct = Math.round((jp.done / jp.total) * 100);
    return {
      totalEpics, totalStories, totalPoints, approvedEpics,
      doneStories: jp.done,
      donePoints: jp.donePoints,
      inProgress: jp.inProgress,
      todo: jp.todo,
      jiraTotal: jp.total,
      jiraTotalPoints: jp.totalPoints,
      devCount, assignmentCount, progressPct,
    };
  }

  // Non-synced: progress based on pipeline step
  const doneStories = project.epics?.reduce((s, e) =>
    s + (e.stories?.filter(st => st.status === 'done').length || 0), 0) || 0;
  const donePoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.filter(st => st.status === 'done').reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;

  let progressPct = 0;
  const cfg = statusConfig[project.status];
  if (cfg) {
    progressPct = (cfg.step / 4) * 100;
  }

  return { totalEpics, totalStories, totalPoints, approvedEpics, doneStories, donePoints, devCount, assignmentCount, progressPct };
}

function getDeadlineInfo(project) {
  if (!project.deadline) return null;
  const { value, unit } = project.deadline;
  if (!value) return null;

  const created = project.createdAt ? new Date(project.createdAt) : new Date();
  const end = new Date(created);
  const v = parseInt(value);
  switch (unit) {
    case 'hours': end.setHours(end.getHours() + v); break;
    case 'days': end.setDate(end.getDate() + v); break;
    case 'months': end.setMonth(end.getMonth() + v); break;
    case 'weeks':
    default: end.setDate(end.getDate() + v * 7); break;
  }

  const now = new Date();
  const msLeft = end - now;
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  const isOverdue = daysLeft < 0;
  const isUrgent = daysLeft >= 0 && daysLeft <= 3;

  return {
    endDate: end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    daysLeft,
    isOverdue,
    isUrgent,
    label: isOverdue ? `${Math.abs(daysLeft)}d overdue` : daysLeft === 0 ? 'Due today' : `${daysLeft}d left`,
  };
}

function getHealthLevel(project, stats) {
  if (project.status === 'synced') {
    // For synced projects, estimate health from completion vs time
    const deadline = getDeadlineInfo(project);
    if (deadline && stats.totalStories > 0) {
      if (deadline.isOverdue && stats.progressPct < 100) return 'critical';
      if (deadline.isUrgent && stats.progressPct < 70) return 'at-risk';
    }
    if (stats.progressPct >= 80) return 'healthy';
    if (stats.progressPct >= 40) return 'at-risk';
    return 'in-progress';
  }
  // Non-synced: show pipeline progress
  return 'in-progress';
}

const healthStyles = {
  'healthy': { bar: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', label: 'Healthy' },
  'at-risk': { bar: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', label: 'At Risk' },
  'critical': { bar: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', label: 'Critical' },
  'in-progress': { bar: 'bg-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', label: 'In Progress' },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: (i) => ({ opacity: 1, y: 0, transition: { delay: i * 0.06, duration: 0.35, ease: [0.16, 1, 0.3, 1] } })
};

export default function ProjectsPage() {
  const { projects, isLoaded, deleteProject, addProject } = useProjects();
  const { templates, saveAsTemplate, deleteTemplate } = useTemplates();
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(null);

  const aggregateStats = useMemo(() => {
    const total = projects.length;
    if (total === 0) return null;

    const active = projects.filter(p => p.status === 'synced').length;
    const completed = projects.filter(p => p.status === 'completed').length;
    const totalPoints = projects.reduce((s, p) =>
      s + (p.epics?.reduce((se, e) => se + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0), 0);

    const withMetrics = projects.filter(p => p.completionMetrics);
    const successRate = withMetrics.length > 0
      ? Math.round((withMetrics.filter(p => p.completionMetrics.onTime).length / withMetrics.length) * 100)
      : null;
    const avgVelocity = withMetrics.length > 0
      ? parseFloat((withMetrics.reduce((s, p) => s + (p.completionMetrics.velocity || 0), 0) / withMetrics.length).toFixed(1))
      : null;

    return { total, active, completed, totalPoints, successRate, avgVelocity };
  }, [projects]);

  const handleSaveAsTemplate = (e, project) => {
    e.preventDefault();
    e.stopPropagation();
    const tpl = saveAsTemplate(project);
    setTemplateSaved(project.id);
    setTimeout(() => setTemplateSaved(null), 2000);
  };

  const handleCreateFromTemplate = (template) => {
    const projectId = Date.now().toString();
    addProject({
      id: projectId,
      name: `${template.name} (Copy)`,
      rawText: template.description,
      createdAt: new Date().toISOString(),
      status: 'epics-ready',
      epics: template.epics.map((e) => ({
        ...e,
        id: `${e.id}-${Date.now()}`,
        stories: e.stories.map((s) => ({ ...s, id: `${s.id}-${Date.now()}` })),
      })),
      assignments: [],
      analyzedDevelopers: [],
      fromTemplate: template.id,
    });
    setShowTemplates(false);
  };

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="mt-1 text-sm text-gray-500">Track and manage your AI-generated project workflows</p>
        </div>
        <div className="flex items-center gap-2">
          {templates.length > 0 && (
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all"
            >
              <FileStack className="h-4 w-4" />
              Templates ({templates.length})
            </button>
          )}
          <Link
            to="/projects/new"
            className="inline-flex items-center gap-2 rounded-xl bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 transition-all"
          >
            <PlusCircle className="h-4 w-4" />
            New Project
          </Link>
        </div>
      </div>

      {/* Templates Panel */}
      <AnimatePresence>
        {showTemplates && templates.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <FileStack className="h-4 w-4 text-blue-500" />
                  Project Templates
                </h3>
                <button onClick={() => setShowTemplates(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {templates.map((tpl) => (
                  <div key={tpl.id} className="rounded-lg border border-gray-200 bg-white p-4 hover:border-blue-300 transition-colors">
                    <h4 className="text-sm font-semibold text-gray-900 truncate">{tpl.name}</h4>
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-400">
                      <span>{tpl.epicCount} epics</span>
                      <span>{tpl.storyCount} stories</span>
                      <span>{tpl.totalPoints} SP</span>
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={() => handleCreateFromTemplate(tpl)}
                        className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                      >
                        <PlusCircle className="h-3 w-3" />
                        Use Template
                      </button>
                      <button
                        onClick={() => deleteTemplate(tpl.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Aggregate Stats Bar */}
      {aggregateStats && (
        <div className="mb-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <MiniStat icon={FolderKanban} value={aggregateStats.total} label="Total Projects" color="gray" />
          <MiniStat icon={Zap} value={aggregateStats.active} label="Active (Synced)" color="teal" />
          <MiniStat icon={Trophy} value={aggregateStats.completed} label="Completed" color="emerald" />
          <MiniStat icon={Layers} value={aggregateStats.totalPoints} label="Total Points" color="purple" />
          {aggregateStats.successRate !== null && (
            <MiniStat icon={Target} value={`${aggregateStats.successRate}%`} label="Success Rate" color="blue" />
          )}
          {aggregateStats.avgVelocity !== null && (
            <MiniStat icon={TrendingUp} value={aggregateStats.avgVelocity} label="Avg Velocity" color="amber" />
          )}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
            <FolderKanban className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-800">No projects yet</h3>
          <p className="mt-1 text-sm text-gray-400 max-w-sm">
            Create your first project to generate epics, analyze developers, and sync to Jira
          </p>
          <Link
            to="/projects/new"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 transition-all"
          >
            <Zap className="h-4 w-4" />
            Create First Project
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project, i) => {
            const stats = getProjectProgress(project);
            const deadline = getDeadlineInfo(project);
            const health = getHealthLevel(project, stats);
            const hs = healthStyles[health];
            const cfg = statusConfig[project.status] || { label: project.status, color: 'bg-gray-100 text-gray-600', icon: BookOpen };
            const StatusIcon = cfg.icon;

            return (
              <motion.div
                key={project.id}
                custom={i}
                variants={cardVariants}
                initial="hidden"
                animate="show"
              >
                <Link
                  to={`/projects/${project.id}`}
                  className="block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-teal-300 transition-all duration-200 overflow-hidden group"
                >
                  {/* Health bar at top */}
                  <div className="h-1.5 bg-gray-100 w-full">
                    <motion.div
                      className={`h-full ${hs.bar} rounded-r-full`}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(stats.progressPct, 3)}%` }}
                      transition={{ duration: 0.8, delay: i * 0.06 + 0.2, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>

                  <div className="p-5">
                    {/* Header row */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-lg truncate group-hover:text-teal-700 transition-colors">
                          {project.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {cfg.label}
                          </span>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${hs.bg} ${hs.text}`}>
                            {hs.label}
                          </span>
                          {project.jiraProjectKey && (
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-mono font-medium text-blue-600">
                              {project.jiraProjectKey}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-3">
                        <button
                          onClick={(e) => handleSaveAsTemplate(e, project)}
                          className={`rounded-lg p-2 transition-colors ${
                            templateSaved === project.id
                              ? 'text-emerald-500 bg-emerald-50'
                              : 'text-gray-300 hover:bg-blue-50 hover:text-blue-500'
                          }`}
                          title={templateSaved === project.id ? 'Template saved!' : 'Save as template'}
                        >
                          {templateSaved === project.id ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (confirm(`Delete "${project.name}"?`)) deleteProject(project.id);
                          }}
                          className="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                          title="Delete project"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-4 gap-3 mt-4">
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{stats.totalEpics}</div>
                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Epics</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{stats.totalStories}</div>
                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Stories</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{stats.totalPoints}</div>
                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Points</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{stats.devCount}</div>
                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Devs</div>
                      </div>
                    </div>

                    {/* Progress section */}
                    <div className="mt-4 pt-3 border-t border-gray-100">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-gray-500">
                          {project.status === 'synced'
                            ? `${stats.doneStories} / ${stats.totalStories} stories complete`
                            : `Pipeline: Step ${cfg.step || 1} of 4`
                          }
                        </span>
                        <span className="text-xs font-semibold text-gray-700">{stats.progressPct}%</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <motion.div
                          className={`h-full rounded-full ${hs.bar}`}
                          initial={{ width: 0 }}
                          animate={{ width: `${stats.progressPct}%` }}
                          transition={{ duration: 0.8, delay: i * 0.06 + 0.3 }}
                        />
                      </div>
                    </div>

                    {/* Footer - deadline and info */}
                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-3">
                        {deadline && (
                          <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                            deadline.isOverdue ? 'text-red-600' : deadline.isUrgent ? 'text-amber-600' : 'text-gray-500'
                          }`}>
                            <Clock className="w-3 h-3" />
                            {deadline.label}
                          </span>
                        )}
                        {project.createdAt && (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                            <Calendar className="w-3 h-3" />
                            {new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                      {/* Dev avatars */}
                      {project.analyzedDevelopers?.length > 0 && (
                        <div className="flex -space-x-2">
                          {project.analyzedDevelopers.slice(0, 4).map((dev) => (
                            <img
                              key={dev.username}
                              src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                              alt={dev.username}
                              className="w-6 h-6 rounded-full ring-2 ring-white"
                              title={dev.username}
                            />
                          ))}
                          {project.analyzedDevelopers.length > 4 && (
                            <div className="w-6 h-6 rounded-full ring-2 ring-white bg-gray-200 flex items-center justify-center text-[9px] font-medium text-gray-600">
                              +{project.analyzedDevelopers.length - 4}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
