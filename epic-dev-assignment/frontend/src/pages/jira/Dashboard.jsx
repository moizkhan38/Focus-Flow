import { useMemo, useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../../lib/api.js';
import { useProjects } from '../../hooks/useProjects';
import { useDevelopers } from '../../hooks/useDevelopers';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FolderOpen, Users, BookOpen, Layers, CheckCircle2, Clock, AlertTriangle,
  TrendingUp, BarChart3, ExternalLink, GitBranch, Target, Zap, Activity, Gauge,
  Trophy, Timer, MessageSquare, ChevronDown, ChevronUp, Shield, Smile, Meh, Frown, RefreshCw
} from 'lucide-react';
import { useRetro } from '../../hooks/useRetro';

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
    teal: 'bg-teal-50 text-teal-600',
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-gray-200 bg-white p-4"
    >
      <div className={`mb-2 inline-flex rounded-lg p-2 ${colorMap[color]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-sm font-medium text-gray-700">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </motion.div>
  );
}

function ProjectCard({ project }) {
  const statusColors = {
    'epics-ready': 'bg-blue-100 text-blue-700',
    'stories-ready': 'bg-purple-100 text-purple-700',
    assigned: 'bg-amber-100 text-amber-700',
    synced: 'bg-emerald-100 text-emerald-700',
    completed: 'bg-teal-100 text-teal-700',
  };
  const statusLabels = {
    'epics-ready': 'Epics Ready',
    'stories-ready': 'Stories Ready',
    assigned: 'Assigned',
    synced: 'Synced to Jira',
    completed: 'Completed',
  };

  const epicCount = project.epics?.length || 0;
  const storyCount = project.epics?.reduce((s, e) => s + (e.stories?.length || 0), 0) || 0;
  const approvedEpics = project.epics?.filter(e => e.status === 'approved').length || 0;
  const assignmentCount = project.assignments?.length || 0;
  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;
  const progress = storyCount > 0 ? Math.round((assignmentCount / storyCount) * 100) : 0;

  return (
    <Link to={`/projects/${project.id}`}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -2 }}
        className="rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-300 hover:shadow-md transition-all"
      >
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{project.name}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColors[project.status] || 'bg-gray-100 text-gray-600'}`}>
                {statusLabels[project.status] || project.status || 'Draft'}
              </span>
              {project.jiraProjectKey && (
                <span className="text-[10px] font-mono text-gray-400">{project.jiraProjectKey}</span>
              )}
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-gray-500 mb-1">
            <span>{assignmentCount}/{storyCount} assigned</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-100">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              className={`h-full rounded-full ${progress === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
            />
          </div>
        </div>

        <div className="flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><Layers className="h-3 w-3" /> {epicCount} epics</span>
          <span className="flex items-center gap-1"><BookOpen className="h-3 w-3" /> {storyCount} stories</span>
          <span className="flex items-center gap-1"><Zap className="h-3 w-3" /> {totalPoints} SP</span>
        </div>

        {project.deadline && (
          <div className="mt-2 flex items-center gap-1 text-[10px] text-gray-400">
            <Clock className="h-3 w-3" />
            {project.deadline.value} {project.deadline.unit}
            {project.sprintCount > 1 && ` · ${project.sprintCount} sprints`}
          </div>
        )}
      </motion.div>
    </Link>
  );
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function Dashboard() {
  const { projects } = useProjects();
  const { developers } = useDevelopers();
  const { retros } = useRetro();

  const [showStandups, setShowStandups] = useState(true);
  const [standups, setStandups] = useState([]);
  const [standupLoading, setStandupLoading] = useState(false);
  const [standupError, setStandupError] = useState(null);
  const [standupProjectFilter, setStandupProjectFilter] = useState('');
  const [expandedStandup, setExpandedStandup] = useState(null);

  const syncedProjectKeys = useMemo(() =>
    projects.filter(p => p.jiraProjectKey).map(p => p.jiraProjectKey),
    [projects]
  );

  const fetchStandups = useCallback(async () => {
    setStandupLoading(true);
    setStandupError(null);
    try {
      const query = standupProjectFilter ? `?project_key=${standupProjectFilter}` : '';
      const res = await apiFetch(`/api/standup/history${query}`);
      const data = await res.json();
      if (data.success) {
        setStandups(data.standups || []);
      } else {
        setStandupError(data.error || 'Failed to load standups');
      }
    } catch {
      setStandupError('Standup bot is not running or unreachable.');
    } finally {
      setStandupLoading(false);
    }
  }, [standupProjectFilter]);

  useEffect(() => {
    if (showStandups) fetchStandups();
  }, [showStandups, fetchStandups]);

  const stats = useMemo(() => {
    let totalEpics = 0, totalStories = 0, totalPoints = 0, totalAssignments = 0;
    let approvedEpics = 0, syncedProjects = 0, assignedProjects = 0;
    const devWorkload = {};

    for (const p of projects) {
      const epics = p.epics || [];
      totalEpics += epics.length;
      approvedEpics += epics.filter(e => e.status === 'approved').length;

      for (const e of epics) {
        const stories = e.stories || [];
        totalStories += stories.length;
        totalPoints += stories.reduce((s, st) => s + (st.storyPoints || 0), 0);
      }

      totalAssignments += (p.assignments || []).length;
      if (p.status === 'synced') syncedProjects++;
      if (p.assignments?.length > 0) assignedProjects++;

      for (const a of (p.assignments || [])) {
        const dev = a.assigned_developer;
        if (dev) {
          if (!devWorkload[dev]) devWorkload[dev] = { stories: 0, points: 0, projects: new Set() };
          devWorkload[dev].stories++;
          devWorkload[dev].points += a.story_points || a.storyPoints || 0;
          devWorkload[dev].projects.add(p.id);
        }
      }
    }

    // Convert Sets to counts
    const devWorkloadList = Object.entries(devWorkload)
      .map(([username, data]) => ({ username, stories: data.stories, points: data.points, projectCount: data.projects.size }))
      .sort((a, b) => b.stories - a.stories);

    return {
      totalProjects: projects.length,
      totalEpics,
      approvedEpics,
      totalStories,
      totalPoints,
      totalAssignments,
      syncedProjects,
      assignedProjects,
      totalDevelopers: developers.length,
      devWorkloadList,
    };
  }, [projects, developers]);

  // Estimation calibration data
  const calibration = useMemo(() => {
    const perProject = [];
    for (const p of projects) {
      if (!p.epics?.length) continue;
      const estimatedPoints = p.epics.reduce((s, e) =>
        s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0);
      const estimatedStories = p.epics.reduce((s, e) => s + (e.stories?.length || 0), 0);
      const jp = p.jiraProgress;
      const donePoints = jp?.donePoints || 0;
      const doneStories = jp?.done || 0;
      const completionRate = estimatedStories > 0 ? Math.round((doneStories / estimatedStories) * 100) : 0;
      const pointAccuracy = estimatedPoints > 0 && donePoints > 0
        ? Math.round((donePoints / estimatedPoints) * 100) : null;
      perProject.push({
        name: p.name,
        id: p.id,
        estimatedPoints,
        estimatedStories,
        donePoints,
        doneStories,
        completionRate,
        pointAccuracy,
        status: p.status,
      });
    }

    // Average accuracy across synced projects
    const synced = perProject.filter((p) => p.pointAccuracy !== null);
    const avgAccuracy = synced.length > 0
      ? Math.round(synced.reduce((s, p) => s + p.pointAccuracy, 0) / synced.length)
      : null;

    // Story point distribution
    const spBuckets = { '1-2': 0, '3-5': 0, '8': 0, '13+': 0 };
    for (const p of projects) {
      for (const e of (p.epics || [])) {
        for (const s of (e.stories || [])) {
          const sp = s.storyPoints || 0;
          if (sp <= 2) spBuckets['1-2']++;
          else if (sp <= 5) spBuckets['3-5']++;
          else if (sp <= 8) spBuckets['8']++;
          else spBuckets['13+']++;
        }
      }
    }

    return { perProject, avgAccuracy, spBuckets };
  }, [projects]);

  const recentProjects = useMemo(() =>
    [...projects].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 6),
    [projects]
  );

  const syncedProjects = useMemo(() => projects.filter(p => p.status === 'synced'), [projects]);

  // Completed project analytics
  const completedAnalytics = useMemo(() => {
    const completed = projects.filter(p => p.status === 'completed' && p.completionMetrics);
    if (completed.length === 0) return null;

    const count = completed.length;
    const onTimeCount = completed.filter(p => p.completionMetrics.onTime).length;
    const successRate = Math.round((onTimeCount / count) * 100);

    const velocities = completed.map(p => p.completionMetrics.velocity || 0);
    const avgVelocity = parseFloat((velocities.reduce((s, v) => s + v, 0) / count).toFixed(1));

    const accuracies = completed.filter(p => p.completionMetrics.estimationAccuracy != null)
      .map(p => p.completionMetrics.estimationAccuracy);
    const avgAccuracy = accuracies.length > 0
      ? Math.round(accuracies.reduce((s, a) => s + a, 0) / accuracies.length)
      : null;

    const durations = completed.map(p => p.completionMetrics.actualDurationDays);
    const avgDuration = Math.round(durations.reduce((s, d) => s + d, 0) / count);

    // Per-project data for charts
    const perProject = completed.map(p => ({
      name: p.name.length > 15 ? p.name.slice(0, 15) + '…' : p.name,
      velocity: p.completionMetrics.velocity || 0,
      accuracy: p.completionMetrics.estimationAccuracy || 0,
      onTime: p.completionMetrics.onTime,
    }));

    // Top contributors across completed projects
    const contributorMap = {};
    for (const p of completed) {
      const m = p.completionMetrics;
      for (const dev of (m.team || [])) {
        if (!contributorMap[dev]) contributorMap[dev] = { projects: 0, stories: 0, points: 0 };
        contributorMap[dev].projects++;
      }
      // Sum delivered stories/points per dev from assignments
      for (const a of (p.assignments || [])) {
        const dev = a.assigned_developer;
        if (dev && contributorMap[dev]) {
          contributorMap[dev].stories++;
          contributorMap[dev].points += a.story_points || a.storyPoints || 0;
        }
      }
    }
    const topContributors = Object.entries(contributorMap)
      .map(([username, data]) => ({ username, ...data }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 5);

    return { count, successRate, avgVelocity, avgAccuracy, avgDuration, perProject, topContributors };
  }, [projects]);

  // Retro insights from completed projects
  const retroInsights = useMemo(() => {
    if (!completedAnalytics) return null;
    const completedIds = projects.filter(p => p.status === 'completed').map(p => p.id);
    const wentWell = [];
    const toImprove = [];
    const actionItems = [];

    for (const id of completedIds) {
      const r = retros[id];
      if (!r) continue;
      wentWell.push(...(r.wentWell || []));
      toImprove.push(...(r.toImprove || []));
      actionItems.push(...(r.actionItems || []));
    }

    if (wentWell.length === 0 && toImprove.length === 0 && actionItems.length === 0) return null;
    return { wentWell: wentWell.slice(0, 3), toImprove: toImprove.slice(0, 3), actionItems: actionItems.slice(0, 3) };
  }, [projects, retros, completedAnalytics]);

  const assignmentRate = stats.totalStories > 0
    ? Math.round((stats.totalAssignments / stats.totalStories) * 100)
    : 0;

  const approvalRate = stats.totalEpics > 0
    ? Math.round((stats.approvedEpics / stats.totalEpics) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">Overview of all projects, teams, and workflow progress</p>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <StatCard icon={FolderOpen} label="Projects" value={stats.totalProjects} sub={`${stats.syncedProjects} synced`} color="blue" />
        <StatCard icon={Layers} label="Epics" value={stats.totalEpics} sub={`${stats.approvedEpics} approved`} color="purple" />
        <StatCard icon={BookOpen} label="Stories" value={stats.totalStories} sub={`${stats.totalPoints} SP total`} color="teal" />
        <StatCard icon={Users} label="Team" value={stats.totalDevelopers} sub="in roster" color="amber" />
        <StatCard icon={CheckCircle2} label="Assigned" value={stats.totalAssignments} sub={`${assignmentRate}% coverage`} color="green" />
        <StatCard icon={GitBranch} label="Jira Synced" value={stats.syncedProjects} sub={`of ${stats.totalProjects}`} color="blue" />
      </div>

      {/* Standup Reports Viewer */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-indigo-500" />
              Team Standup Reports
            </h2>
            <p className="text-sm text-gray-500">View standup updates submitted by your team via Slack.</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={standupProjectFilter}
              onChange={(e) => setStandupProjectFilter(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
            >
              <option value="">All Projects</option>
              {syncedProjectKeys.map(key => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={fetchStandups}
              disabled={standupLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${standupLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowStandups(prev => !prev)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              {showStandups ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showStandups ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {showStandups && (
          <div className="mt-4">
            {standupError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 mb-3">
                {standupError}
              </div>
            )}

            {standupLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="animate-pulse rounded-lg border border-gray-100 p-4">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="h-8 w-8 rounded-full bg-gray-200" />
                      <div className="h-3 w-32 rounded bg-gray-200" />
                      <div className="h-3 w-16 rounded bg-gray-100 ml-auto" />
                    </div>
                    <div className="h-3 w-3/4 rounded bg-gray-100" />
                  </div>
                ))}
              </div>
            ) : standups.length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No standup reports yet</p>
                <p className="text-xs text-gray-300 mt-1">Team members can submit standups via the /standup command in Slack</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {standups.map((s, i) => {
                  const isExpanded = expandedStandup === i;
                  const sentimentIcon = s.sentiment === 'Positive' ? Smile : s.sentiment === 'Negative' ? Frown : Meh;
                  const sentimentColor = s.sentiment === 'Positive' ? 'text-emerald-500' : s.sentiment === 'Negative' ? 'text-rose-500' : 'text-amber-500';
                  const SentimentIcon = sentimentIcon;
                  const ts = s.timestamp ? new Date(s.timestamp) : null;
                  const timeAgo = ts ? formatTimeAgo(ts) : '';

                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className={`rounded-lg border ${s.is_blocker ? 'border-rose-200 bg-rose-50/30' : 'border-gray-100'} p-3 cursor-pointer hover:bg-gray-50/50 transition-colors`}
                      onClick={() => setExpandedStandup(isExpanded ? null : i)}
                    >
                      <div className="flex items-center gap-3">
                        {s.avatar ? (
                          <img src={s.avatar} className="h-7 w-7 rounded-full flex-shrink-0" alt="" />
                        ) : (
                          <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600 flex-shrink-0">
                            {(s.user_name || s.user_id || '?')[0]?.toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-gray-800">{s.user_name || s.user_id || 'Unknown'}</span>
                            <span className="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{s.project_key}</span>
                            {s.is_blocker && (
                              <span className="text-[10px] font-medium text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                                <Shield className="h-2.5 w-2.5" /> Blocker
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 truncate mt-0.5">{s.ai_summary_today || s.ai_summary_yesterday || 'No summary'}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <SentimentIcon className={`h-3.5 w-3.5 ${sentimentColor}`} />
                          <span className="text-[10px] text-gray-400">{timeAgo}</span>
                          {isExpanded ? <ChevronUp className="h-3 w-3 text-gray-300" /> : <ChevronDown className="h-3 w-3 text-gray-300" />}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">Yesterday</p>
                            <p className="text-xs text-gray-700">{s.ai_summary_yesterday || '-'}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">Today</p>
                            <p className="text-xs text-gray-700">{s.ai_summary_today || '-'}</p>
                          </div>
                          {s.is_blocker && s.blocker_details && (
                            <div className="rounded-lg bg-rose-50 border border-rose-200 p-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 mb-1">Blocker Details</p>
                              <p className="text-xs text-rose-700"><strong>Type:</strong> {s.blocker_details.type}</p>
                              <p className="text-xs text-rose-700"><strong>Impact:</strong> {s.blocker_details.impact}</p>
                              {s.blocker_details.recommendation && (
                                <p className="text-xs text-rose-700"><strong>Recommendation:</strong> {s.blocker_details.recommendation}</p>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-4 text-[10px] text-gray-400">
                            {s.finished_tickets?.length > 0 && (
                              <span>Done: {s.finished_tickets.join(', ')}</span>
                            )}
                            {s.today_tickets?.length > 0 && (
                              <span>Working on: {s.today_tickets.join(', ')}</span>
                            )}
                            <span className={sentimentColor}>Sentiment: {s.sentiment}</span>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Workflow Progress */}
        <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-500" />
            Workflow Progress
          </h2>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Epic Approval Rate</span>
                <span className="font-medium">{approvalRate}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${approvalRate}%` }}
                  transition={{ duration: 0.6 }}
                  className="h-full rounded-full bg-purple-500"
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{stats.approvedEpics} of {stats.totalEpics} epics approved</p>
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Story Assignment Coverage</span>
                <span className="font-medium">{assignmentRate}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${assignmentRate}%` }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                  className="h-full rounded-full bg-teal-500"
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{stats.totalAssignments} of {stats.totalStories} stories assigned</p>
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Jira Sync Rate</span>
                <span className="font-medium">{stats.totalProjects > 0 ? Math.round((stats.syncedProjects / stats.totalProjects) * 100) : 0}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${stats.totalProjects > 0 ? (stats.syncedProjects / stats.totalProjects) * 100 : 0}%` }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                  className="h-full rounded-full bg-blue-500"
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{stats.syncedProjects} of {stats.totalProjects} projects synced to Jira</p>
            </div>
          </div>
        </div>

        {/* Team Workload */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-500" />
            Team Workload
          </h2>
          {stats.devWorkloadList.length > 0 ? (
            <div className="space-y-3">
              {stats.devWorkloadList.slice(0, 8).map((dev, i) => {
                const rosterDev = developers.find(d => d.username === dev.username);
                const maxStories = stats.devWorkloadList[0]?.stories || 1;
                return (
                  <motion.div
                    key={dev.username}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-2"
                  >
                    {rosterDev?.avatar_url || rosterDev?.avatar ? (
                      <img src={rosterDev.avatar_url || rosterDev.avatar} className="h-6 w-6 rounded-full flex-shrink-0" alt="" />
                    ) : (
                      <div className="h-6 w-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
                        {dev.username[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-gray-700 truncate">{dev.username}</span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0 ml-1">
                          {dev.stories} {dev.stories === 1 ? 'story' : 'stories'} · {dev.points} SP
                        </span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-gray-100 mt-1">
                        <div
                          className="h-full rounded-full bg-amber-400"
                          style={{ width: `${(dev.stories / maxStories) * 100}%` }}
                        />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-4">No assignments yet</p>
          )}
        </div>
      </div>

      {/* Estimation Calibration */}
      {calibration.perProject.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Accuracy Overview */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Gauge className="h-4 w-4 text-indigo-500" />
              Estimation Calibration
            </h2>
            {calibration.avgAccuracy !== null && (
              <div className="mb-4 flex items-center gap-4">
                <div className={`text-3xl font-bold ${
                  calibration.avgAccuracy >= 80 ? 'text-emerald-600' :
                  calibration.avgAccuracy >= 50 ? 'text-amber-600' : 'text-red-600'
                }`}>
                  {calibration.avgAccuracy}%
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700">Average Accuracy</p>
                  <p className="text-[10px] text-gray-400">Completed points vs estimated across synced projects</p>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {calibration.perProject.slice(0, 5).map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="block">
                  <div className="flex items-center gap-2 rounded-lg hover:bg-gray-50 px-2 py-1.5 transition-colors">
                    <span className="text-xs font-medium text-gray-700 truncate flex-1">{p.name}</span>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{p.doneStories}/{p.estimatedStories} stories</span>
                    <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className={`h-full rounded-full ${
                          p.completionRate >= 80 ? 'bg-emerald-500' :
                          p.completionRate >= 40 ? 'bg-amber-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(p.completionRate, 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-gray-500 w-8 text-right flex-shrink-0">{p.completionRate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Story Point Distribution */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-teal-500" />
              Story Point Distribution
            </h2>
            <div className="space-y-3">
              {Object.entries(calibration.spBuckets).map(([label, count]) => {
                const maxCount = Math.max(...Object.values(calibration.spBuckets), 1);
                const pct = Math.round((count / maxCount) * 100);
                return (
                  <div key={label}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-600">{label} points</span>
                      <span className="text-xs font-mono text-gray-500">{count} stories</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-teal-400 to-indigo-500 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.5 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[10px] text-gray-400">
              Distribution of story point estimates across all {stats.totalStories} stories
            </p>
          </div>
        </div>
      )}

      {/* Completed Projects Insights */}
      {completedAnalytics && (
        <div className="mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" />
            Completed Projects Insights
          </h2>

          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={Trophy} label="Completed" value={completedAnalytics.count} sub="projects finished" color="amber" />
            <StatCard icon={Target} label="Success Rate" value={`${completedAnalytics.successRate}%`} sub="delivered on time" color="green" />
            <StatCard icon={TrendingUp} label="Avg Velocity" value={`${completedAnalytics.avgVelocity}`} sub="pts/week" color="blue" />
            <StatCard icon={Timer} label="Avg Duration" value={`${completedAnalytics.avgDuration}d`} sub="days to complete" color="purple" />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Velocity per project */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
              <h3 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-blue-500" />
                Velocity by Project (pts/week)
              </h3>
              <div className="space-y-2">
                {completedAnalytics.perProject.map((p, i) => {
                  const maxV = Math.max(...completedAnalytics.perProject.map(x => x.velocity), 1);
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[11px] text-gray-600 truncate flex-1">{p.name}</span>
                        <span className="text-[11px] font-mono text-gray-500 ml-2">{p.velocity}</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-gradient-to-r from-blue-400 to-blue-600 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${(p.velocity / maxV) * 100}%` }}
                          transition={{ duration: 0.5, delay: i * 0.08 }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Estimation accuracy per project */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
              <h3 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-teal-500" />
                Estimation Accuracy by Project (%)
              </h3>
              <div className="space-y-2">
                {completedAnalytics.perProject.map((p, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[11px] text-gray-600 truncate flex-1">{p.name}</span>
                      <span className={`text-[11px] font-mono ${p.accuracy >= 80 ? 'text-emerald-600' : p.accuracy >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                        {p.accuracy}%
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full ${p.accuracy >= 80 ? 'bg-emerald-500' : p.accuracy >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(p.accuracy, 100)}%` }}
                        transition={{ duration: 0.5, delay: i * 0.08 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Top Contributors */}
          {completedAnalytics.topContributors.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
              <h3 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-amber-500" />
                Top Contributors (Completed Projects)
              </h3>
              <div className="space-y-2">
                {completedAnalytics.topContributors.map((dev, i) => {
                  const rosterDev = developers.find(d => d.username === dev.username);
                  const maxPts = completedAnalytics.topContributors[0]?.points || 1;
                  return (
                    <motion.div
                      key={dev.username}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="flex items-center gap-2"
                    >
                      {rosterDev?.avatar_url || rosterDev?.avatar ? (
                        <img src={rosterDev.avatar_url || rosterDev.avatar} className="h-6 w-6 rounded-full flex-shrink-0" alt="" />
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
                          {dev.username[0]?.toUpperCase()}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-medium text-gray-700 truncate">{dev.username}</span>
                          <span className="text-[10px] text-gray-400 flex-shrink-0 ml-1">
                            {dev.projects} {dev.projects === 1 ? 'project' : 'projects'} · {dev.stories} stories · {dev.points} SP
                          </span>
                        </div>
                        <div className="h-1 w-full rounded-full bg-gray-100 mt-1">
                          <div className="h-full rounded-full bg-amber-400" style={{ width: `${(dev.points / maxPts) * 100}%` }} />
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Retro Highlights */}
          {retroInsights && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
              <h3 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-indigo-500" />
                Retrospective Highlights
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {retroInsights.wentWell.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 mb-1.5">Went Well</p>
                    <ul className="space-y-1">
                      {retroInsights.wentWell.map((item, i) => (
                        <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400 mt-0.5 flex-shrink-0" />
                          <span className="line-clamp-2">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {retroInsights.toImprove.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 mb-1.5">To Improve</p>
                    <ul className="space-y-1">
                      {retroInsights.toImprove.map((item, i) => (
                        <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                          <AlertTriangle className="h-3 w-3 text-amber-400 mt-0.5 flex-shrink-0" />
                          <span className="line-clamp-2">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {retroInsights.actionItems.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 mb-1.5">Action Items</p>
                    <ul className="space-y-1">
                      {retroInsights.actionItems.map((item, i) => (
                        <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                          <Zap className="h-3 w-3 text-blue-400 mt-0.5 flex-shrink-0" />
                          <span className="line-clamp-2">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Jira-synced projects */}
      {syncedProjects.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Target className="h-4 w-4 text-emerald-500" />
            Active Jira Projects
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {syncedProjects.map(p => (
              <Link key={p.id} to={`/projects/${p.id}`} className="flex items-center gap-3 rounded-lg border border-gray-100 p-3 hover:bg-gray-50 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400">
                    {p.jiraProjectKey && <span className="font-mono">{p.jiraProjectKey}</span>}
                    {p.sprintCount && <span>· {p.sprintCount} sprint{p.sprintCount > 1 ? 's' : ''}</span>}
                    {p.assignments && <span>· {p.assignments.length} tasks</span>}
                  </div>
                </div>
                <ExternalLink className="h-3 w-3 text-gray-300 flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent Projects */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-blue-500" />
            {projects.length > 6 ? 'Recent Projects' : 'All Projects'}
          </h2>
          {projects.length > 6 && (
            <Link to="/projects" className="text-xs text-blue-600 hover:text-blue-800">View all</Link>
          )}
        </div>
        {recentProjects.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentProjects.map((p, i) => (
              <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <ProjectCard project={p} />
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <FolderOpen className="h-10 w-10 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">No projects yet</p>
            <Link to="/projects/new" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
              Create your first project
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
