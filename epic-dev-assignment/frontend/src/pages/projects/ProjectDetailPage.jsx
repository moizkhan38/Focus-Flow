import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../../lib/api.js';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useProjects } from '../../hooks/useProjects';
import { useSprintIssues, useProjectIssues, useBurndownData, useSprintDetails } from '../../hooks/useSprintData';
import { useAlerts } from '../../hooks/useAlerts';
import { calculateHealthScore } from '../../utils/healthScore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, Columns3, Users, BookOpen, CheckCircle2, Clock, AlertTriangle,
  TrendingUp, TrendingDown, BarChart3, ChevronDown, ExternalLink, RefreshCw,
  Target, Layers, GitBranch, Activity, Calendar, Shield, Flame, Bug,
  ClipboardCheck, UserPlus, LayoutDashboard, FileText, Trophy
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, AreaChart, Area
} from 'recharts';
import { useKanbanSync } from '../../hooks/useKanbanSync';
import { useDevelopers } from '../../hooks/useDevelopers';
import ExportButtons from '../../components/reports/ExportButtons';
import KanbanBoard from '../../components/kanban/KanbanBoard';
import StoryDependencies from '../../components/projects/StoryDependencies';
import SprintRetro from '../../components/projects/SprintRetro';
import SprintCompletionBanner from '../../components/projects/SprintCompletionBanner';
import SprintCompletionModal from '../../components/projects/SprintCompletionModal';
import { useSprintCompletion } from '../../hooks/useSprintCompletion';
import { buildSprintReport } from '../../utils/buildSprintReport';
import { buildCompletionMetrics } from '../../utils/completionMetrics';

const statusConfig = {
  'epics-ready': { label: 'Epics Ready', color: 'bg-blue-100 text-blue-700' },
  'stories-ready': { label: 'Stories Ready', color: 'bg-purple-100 text-purple-700' },
  assigned: { label: 'Assigned', color: 'bg-amber-100 text-amber-700' },
  synced: { label: 'Synced to Jira', color: 'bg-emerald-100 text-emerald-700' },
  completed: { label: 'Completed', color: 'bg-emerald-100 text-emerald-700' },
};

const chartTooltip = {
  contentStyle: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.08)' },
  itemStyle: { color: '#1f2937' }, labelStyle: { color: '#6b7280' }
};

function ProjectDescription({ text, project }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_LEN = 180;
  const isLong = text.length > MAX_LEN;

  // Only approved (or status-less, for projects pre-approval flow) epics & stories.
  const approvedEpics = (project?.epics || []).filter(e => !e.status || e.status === 'approved');
  const approvedStoriesOf = (epic) =>
    (epic.stories || []).filter(s => !s.status || s.status === 'approved');

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/80 max-w-3xl">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left group"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-gray-600">
          <FileText className="h-3.5 w-3.5" />
          Project Description
          {approvedEpics.length > 0 && (
            <span className="text-[10px] font-normal text-gray-400">
              · {approvedEpics.length} epic{approvedEpics.length !== 1 ? 's' : ''}
            </span>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 space-y-4">
              {/* Original description */}
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{text}</p>

              {/* Approved epics → stories → acceptance criteria + test cases */}
              {approvedEpics.length > 0 && (
                <div className="border-t border-gray-200 pt-3 space-y-3">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                    Approved Scope
                  </h4>
                  {approvedEpics.map((epic) => {
                    const stories = approvedStoriesOf(epic);
                    return (
                      <div key={epic.id || epic.epic_id} className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-semibold text-gray-800">{epic.title || epic.epic_title}</span>
                          {epic.jiraKey && (
                            <span className="text-[10px] font-mono text-blue-600">{epic.jiraKey}</span>
                          )}
                          <span className="ml-auto text-[10px] text-gray-400">
                            {stories.length} stor{stories.length === 1 ? 'y' : 'ies'}
                          </span>
                        </div>
                        {epic.description && (
                          <p className="text-[11px] text-gray-500 mb-2 whitespace-pre-wrap">{epic.description}</p>
                        )}
                        {stories.length > 0 && (
                          <ul className="space-y-2">
                            {stories.map((story) => {
                              const ac = story.acceptanceCriteria;
                              const tcs = story.testCases || [];
                              return (
                                <li key={story.id || story.story_id} className="rounded-md bg-gray-50 p-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-medium text-gray-700 flex-1">{story.title || story.story_title}</span>
                                    {story.storyPoints > 0 && (
                                      <span className="text-[10px] font-mono bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-500">{story.storyPoints} SP</span>
                                    )}
                                    {story.jiraKey && (
                                      <span className="text-[10px] font-mono text-blue-600">{story.jiraKey}</span>
                                    )}
                                  </div>
                                  {story.description && (
                                    <p className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap">{story.description}</p>
                                  )}
                                  {ac && (
                                    <div className="mt-2 rounded border border-emerald-100 bg-emerald-50/50 p-2">
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <ClipboardCheck className="w-3 h-3 text-emerald-600" />
                                        <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700">Acceptance Criteria</span>
                                      </div>
                                      <p className="text-[11px] text-gray-700 whitespace-pre-line">{ac}</p>
                                    </div>
                                  )}
                                  {tcs.length > 0 && (
                                    <div className="mt-2 space-y-1.5">
                                      {tcs.map((tc, i) => (
                                        <div key={i} className="rounded border border-blue-100 bg-blue-50/50 p-2">
                                          <div className="flex items-center gap-1.5 mb-1">
                                            <FileText className="w-3 h-3 text-blue-600" />
                                            <span className="text-[9px] font-semibold uppercase tracking-wider text-blue-700">Test Case</span>
                                            {tc.id && <span className="text-[9px] font-mono bg-blue-100 text-blue-600 rounded px-1 py-0.5">{tc.id}</span>}
                                          </div>
                                          {tc.description && <p className="text-[11px] text-gray-700">{tc.description}</p>}
                                          {tc.preconditions && (
                                            <p className="text-[11px] text-gray-600 mt-1"><span className="font-semibold text-gray-500">Preconditions:</span> {tc.preconditions}</p>
                                          )}
                                          {tc.userAction && (
                                            <p className="text-[11px] text-gray-600 mt-1"><span className="font-semibold text-gray-500">Steps:</span> {tc.userAction}</p>
                                          )}
                                          {tc.expectedResults?.length > 0 && (
                                            <div className="mt-1">
                                              <span className="text-[10px] font-semibold text-gray-500 uppercase">Expected</span>
                                              <ol className="list-decimal list-inside mt-0.5 space-y-0.5">
                                                {tc.expectedResults.map((r, j) => (
                                                  <li key={j} className="text-[11px] text-gray-600">{r}</li>
                                                ))}
                                              </ol>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {!expanded && isLong && (
        <p className="px-3.5 pb-2.5 text-sm text-gray-400 truncate">{text.slice(0, MAX_LEN)}...</p>
      )}
      {!expanded && !isLong && (
        <p className="px-3.5 pb-2.5 text-sm text-gray-500">{text}</p>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subtext, color = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color === 'text-teal-600' ? 'bg-teal-50' : color === 'text-purple-600' ? 'bg-purple-50' : color === 'text-amber-600' ? 'bg-amber-50' : color === 'text-emerald-600' ? 'bg-emerald-50' : color === 'text-red-600' ? 'bg-red-50' : color === 'text-blue-600' ? 'bg-blue-50' : 'bg-gray-50'}`}>
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray-400">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {subtext && <div className="text-xs text-gray-400 mt-0.5">{subtext}</div>}
    </div>
  );
}

function HealthBar({ score, level }) {
  const colors = {
    healthy: { bar: 'bg-emerald-500', text: 'text-emerald-700', label: 'Healthy' },
    'at-risk': { bar: 'bg-amber-500', text: 'text-amber-700', label: 'At Risk' },
    critical: { bar: 'bg-red-500', text: 'text-red-700', label: 'Critical' },
  };
  const c = colors[level] || colors.healthy;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-sm font-semibold ${c.text}`}>{c.label}</span>
        <span className="text-sm font-bold text-gray-900">{score}/100</span>
      </div>
      <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${c.bar}`}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}

function normalizeStatus(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'Done';
  if (s.includes('progress') || s.includes('review')) return 'In Progress';
  return 'To Do';
}


function computeLocalHealth(project) {
  const factors = [];
  let score = 100;
  const totalEpics = project.epics?.length || 0;
  const approvedEpics = project.epics?.filter(e => e.status === 'approved').length || 0;
  const totalStories = project.epics?.reduce((s, e) => s + (e.stories?.length || 0), 0) || 0;
  const assignmentCount = project.assignments?.length || 0;
  const devCount = project.analyzedDevelopers?.length || 0;

  // Epic approval progress (30 points)
  const approvalPct = totalEpics > 0 ? approvedEpics / totalEpics : 0;
  const approvalScore = Math.round(approvalPct * 30);
  factors.push({ name: 'Epic Approval', score: approvalScore, max: 30, detail: `${approvedEpics}/${totalEpics} approved` });
  score -= 30 - approvalScore;

  // Developer assignment (30 points)
  const assignPct = totalEpics > 0 ? Math.min(1, assignmentCount / totalEpics) : 0;
  const assignScore = Math.round(assignPct * 30);
  factors.push({ name: 'Assignments', score: assignScore, max: 30, detail: `${assignmentCount}/${totalEpics} epics assigned` });
  score -= 30 - assignScore;

  // Team readiness (20 points) — have devs been analyzed?
  const teamScore = devCount > 0 ? 20 : 0;
  factors.push({ name: 'Team', score: teamScore, max: 20, detail: devCount > 0 ? `${devCount} developer${devCount !== 1 ? 's' : ''} analyzed` : 'No developers analyzed' });
  score -= 20 - teamScore;

  // Deadline pressure (20 points)
  let deadlineScore = 20;
  if (project.deadline?.value) {
    const created = project.createdAt ? new Date(project.createdAt) : new Date();
    const end = new Date(created);
    const v = parseInt(project.deadline.value);
    switch (project.deadline.unit) {
      case 'hours': end.setHours(end.getHours() + v); break;
      case 'days': end.setDate(end.getDate() + v); break;
      case 'months': end.setMonth(end.getMonth() + v); break;
      default: end.setDate(end.getDate() + v * 7); break;
    }
    const daysLeft = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) {
      deadlineScore = 0;
      factors.push({ name: 'Deadline', score: 0, max: 20, detail: `${Math.abs(daysLeft)}d overdue` });
    } else if (daysLeft <= 3) {
      deadlineScore = 5;
      factors.push({ name: 'Deadline', score: 5, max: 20, detail: `${daysLeft}d remaining — urgent` });
    } else if (daysLeft <= 7) {
      deadlineScore = 12;
      factors.push({ name: 'Deadline', score: 12, max: 20, detail: `${daysLeft}d remaining` });
    } else {
      factors.push({ name: 'Deadline', score: 20, max: 20, detail: `${daysLeft}d remaining` });
    }
  } else {
    factors.push({ name: 'Deadline', score: 20, max: 20, detail: 'No deadline set' });
  }
  score -= 20 - deadlineScore;

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const level = finalScore >= 75 ? 'healthy' : finalScore >= 50 ? 'at-risk' : 'critical';
  return { score: finalScore, level, factors };
}

function StoryDetail({ story, assignment }) {
  const [expanded, setExpanded] = useState(false);
  const hasAC = !!story.acceptanceCriteria;
  const hasTC = story.testCases?.length > 0;
  const expandable = hasAC || hasTC;

  return (
    <div className="rounded-lg bg-gray-50 overflow-hidden">
      <div
        className={`flex items-center gap-3 py-2 px-3 ${expandable ? 'cursor-pointer hover:bg-gray-100 transition-colors' : ''}`}
        onClick={() => expandable && setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-gray-800">{story.title}</div>
          {story.description && <div className="text-[11px] text-gray-400 truncate mt-0.5">{story.description}</div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {assignment && (
            <span className="text-[10px] font-medium text-teal-600 bg-teal-50 rounded px-1.5 py-0.5">@{assignment.assigned_developer}</span>
          )}
          {hasAC && <ClipboardCheck className="w-3 h-3 text-emerald-400" title="Has acceptance criteria" />}
          {hasTC && <FileText className="w-3 h-3 text-blue-400" title="Has test cases" />}
          {story.storyPoints > 0 && <span className="text-[10px] font-mono bg-white rounded border border-gray-200 px-1.5 py-0.5 text-gray-500">{story.storyPoints} SP</span>}
          {story.jiraKey && <span className="text-[10px] font-mono text-blue-600">{story.jiraKey}</span>}
          {expandable && (
            <motion.div animate={{ rotate: expanded ? 180 : 0 }}>
              <ChevronDown className="w-3 h-3 text-gray-400" />
            </motion.div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-3">
              {/* Acceptance Criteria */}
              {hasAC && (
                <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <ClipboardCheck className="w-3 h-3 text-emerald-600" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Acceptance Criteria</span>
                  </div>
                  <p className="text-xs text-gray-700 whitespace-pre-line">{story.acceptanceCriteria}</p>
                </div>
              )}

              {/* Test Cases */}
              {hasTC && story.testCases.map((tc, i) => (
                <div key={i} className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-3 h-3 text-blue-600" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">Test Case</span>
                    {tc.id && <span className="text-[10px] font-mono bg-blue-100 text-blue-600 rounded px-1.5 py-0.5">{tc.id}</span>}
                  </div>
                  {tc.description && <p className="text-xs text-gray-700 mb-2">{tc.description}</p>}
                  <div className="space-y-2">
                    {tc.preconditions && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Preconditions</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.preconditions}</p>
                      </div>
                    )}
                    {tc.testData && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Test Data</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.testData}</p>
                      </div>
                    )}
                    {tc.userAction && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Steps</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.userAction}</p>
                      </div>
                    )}
                    {tc.expectedResults?.length > 0 && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Expected Results</span>
                        <ol className="mt-1 space-y-0.5 list-decimal list-inside">
                          {tc.expectedResults.map((r, j) => (
                            <li key={j} className="text-xs text-gray-600">{r}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EpicsStories({ project }) {
  const [expandedEpic, setExpandedEpic] = useState(null);

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Layers className="w-4 h-4 text-purple-500" /> Epics & Stories
      </h3>
      <div className="space-y-2">
        {(project.epics || []).map((epic) => {
          const storyCount = epic.stories?.length || 0;
          const epicPoints = epic.stories?.reduce((s, st) => s + (st.storyPoints || 0), 0) || 0;
          const isExpanded = expandedEpic === epic.id;
          // Show epic-level developer only for old-format assignments (no story_id)
          const epicAssignments = (project.assignments || []).filter(a => (a.epic_id || a.epicId) === epic.id);
          const assignment = epicAssignments.length > 0 && !epicAssignments[0].story_id ? epicAssignments[0] : null;

          return (
            <div key={epic.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setExpandedEpic(isExpanded ? null : epic.id)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {epic.jiraKey && <span className="text-[10px] font-mono bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">{epic.jiraKey}</span>}
                  <span className="text-sm font-medium text-gray-900 truncate">{epic.title}</span>
                  <span className={`text-[10px] rounded-full px-2 py-0.5 ${epic.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {epic.status || 'pending'}
                  </span>
                </div>
                <div className="flex items-center gap-3 ml-3 shrink-0">
                  <span className="text-xs text-gray-400">{storyCount} stories · {epicPoints} pts</span>
                  {assignment && (
                    <span className="text-xs text-teal-600">@{assignment.assigned_developer || assignment.developer}</span>
                  )}
                  <motion.div animate={{ rotate: isExpanded ? 180 : 0 }}>
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  </motion.div>
                </div>
              </button>
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-3 border-t border-gray-100 pt-3 space-y-2">
                      {epic.description && <p className="text-xs text-gray-500 mb-2">{epic.description}</p>}
                      {(epic.stories || []).map(story => {
                        const storyAssignment = (project.assignments || []).find(a =>
                          a.story_id ? a.story_id === story.id : false
                        );
                        return <StoryDetail key={story.id} story={story} assignment={storyAssignment} />;
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StoryPointsChart({ project }) {
  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;
  if (!project.epics?.length) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-teal-500" /> Story Points by Epic
      </h3>
      <div className="space-y-3">
        {project.epics.map((epic) => {
          const epicPts = epic.stories?.reduce((s, st) => s + (st.storyPoints || 0), 0) || 0;
          const pct = totalPoints > 0 ? Math.round((epicPts / totalPoints) * 100) : 0;
          return (
            <div key={epic.id}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-700 truncate max-w-[60%]">{epic.title}</span>
                <span className="text-xs font-mono text-gray-500">{epicPts} pts ({pct}%)</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-teal-400 to-teal-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeveloperTiles({ project }) {
  if (!project.analyzedDevelopers?.length) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Users className="w-4 h-4 text-teal-500" /> Assigned Developers
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {project.analyzedDevelopers.map(dev => {
          const assigned = (project.assignments || []).filter(a =>
            (a.assigned_developer || a.developer) === dev.username
          );
          return (
            <div key={dev.username} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
              <img
                src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                alt={dev.username}
                className="w-10 h-10 rounded-lg ring-1 ring-gray-200"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{dev.username}</div>
                <div className="text-xs text-gray-400 truncate">{dev.primary_expertise || dev.analysis?.expertise?.primary || 'Developer'}</div>
                <div className="text-[10px] text-teal-600 font-medium mt-0.5">{assigned.length} {assigned.some(a => a.story_id) ? (assigned.length === 1 ? 'story' : 'stories') : (assigned.length === 1 ? 'epic' : 'epics')} assigned</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompletedProjectSummary({ project }) {
  const m = project.completionMetrics;
  if (!m) return null;

  const completedDate = m.completedAt
    ? new Date(m.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-emerald-100 p-2">
            <Trophy className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-semibold text-emerald-800">Project Complete</h3>
            {completedDate && <p className="text-xs text-emerald-600">Completed {completedDate}</p>}
          </div>
        </div>
        {m.onTime !== null && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${
            m.onTime ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}>
            {m.onTime ? 'On Time' : `Delayed ${m.delayDays}d`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Duration</div>
          <div className="text-sm font-bold text-gray-900">{m.actualDurationDays}d</div>
          {m.plannedDurationDays && <div className="text-[10px] text-gray-400">of {m.plannedDurationDays}d planned</div>}
        </div>
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Delivered</div>
          <div className="text-sm font-bold text-gray-900">{m.deliveredPoints} pts</div>
          <div className="text-[10px] text-gray-400">of {m.estimatedPoints} estimated</div>
        </div>
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Accuracy</div>
          <div className="text-sm font-bold text-gray-900">{m.estimationAccuracy ?? '—'}%</div>
        </div>
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Velocity</div>
          <div className="text-sm font-bold text-gray-900">{m.velocity} pts/wk</div>
        </div>
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Stories</div>
          <div className="text-sm font-bold text-gray-900">{m.completedStories}/{m.totalStories}</div>
        </div>
        <div className="rounded-lg bg-white/60 px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Health</div>
          <div className={`text-sm font-bold ${
            m.finalHealthScore?.level === 'healthy' ? 'text-emerald-600' :
            m.finalHealthScore?.level === 'at-risk' ? 'text-amber-600' : 'text-red-600'
          }`}>{m.finalHealthScore?.score ?? '—'}/100</div>
        </div>
      </div>

      {/* Team */}
      {project.analyzedDevelopers?.length > 0 && (
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs text-emerald-600 font-medium">Team:</span>
          <div className="flex -space-x-2">
            {project.analyzedDevelopers.slice(0, 6).map(dev => (
              <img
                key={dev.username}
                src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                alt={dev.username}
                title={dev.username}
                className="w-7 h-7 rounded-full ring-2 ring-white"
              />
            ))}
            {project.analyzedDevelopers.length > 6 && (
              <div className="w-7 h-7 rounded-full bg-gray-200 ring-2 ring-white flex items-center justify-center text-[10px] font-medium text-gray-600">
                +{project.analyzedDevelopers.length - 6}
              </div>
            )}
          </div>
          <span className="text-xs text-gray-500">{m.sprintCount} sprint{m.sprintCount !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
}

function LocalProjectView({ project }) {
  const { updateProject } = useProjects();
  const totalEpics = project.epics?.length || 0;
  const totalStories = project.epics?.reduce((s, e) => s + (e.stories?.length || 0), 0) || 0;
  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;
  const approvedEpics = project.epics?.filter(e => e.status === 'approved').length || 0;
  const devCount = project.analyzedDevelopers?.length || 0;

  const localHealth = useMemo(() => computeLocalHealth(project), [project]);

  const nextStep = (() => {
    if (!project.status || project.status === 'epics-ready') {
      return { message: 'Your epics are ready for review.', action: 'Verify Epics', link: `/projects/${project.id}/verify`, icon: ClipboardCheck };
    }
    if (project.status === 'stories-ready') {
      return { message: 'Stories are ready \u2014 assign developers next.', action: 'Assign Developers', link: `/projects/${project.id}/assign`, icon: UserPlus };
    }
    if (project.status === 'assigned') {
      return { message: 'Team assigned \u2014 sync to Jira to start sprints.', action: 'Sync to Jira', link: `/projects/${project.id}/assign`, icon: ExternalLink };
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      {/* Next Steps Banner */}
      {nextStep && (
        <div className="rounded-xl border border-teal-200 bg-gradient-to-r from-teal-50 to-blue-50 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-teal-100 p-2">
              <ArrowRight className="w-4 h-4 text-teal-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Next Step</h3>
              <p className="text-sm text-gray-600">{nextStep.message}</p>
            </div>
          </div>
          <Link
            to={nextStep.link}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 transition-all"
          >
            <nextStep.icon className="h-4 w-4" /> {nextStep.action}
          </Link>
        </div>
      )}

      {/* Project Health + Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 md:col-span-1">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-5 h-5 text-teal-500" />
            <h3 className="text-sm font-semibold text-gray-900">Project Readiness</h3>
          </div>
          <HealthBar score={localHealth.score} level={localHealth.level} />
          <div className="mt-3 space-y-2">
            {localHealth.factors.map((f, i) => (
              <div key={i}>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">{f.name}</span>
                  <span className="text-[11px] font-mono text-gray-700">{f.score}/{f.max}</span>
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">{f.detail}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="md:col-span-2 grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard icon={Layers} label="Epics" value={totalEpics} subtext={`${approvedEpics} approved`} color="text-purple-600" />
          <StatCard icon={BookOpen} label="Stories" value={totalStories} color="text-blue-600" />
          <StatCard icon={Target} label="Story Points" value={totalPoints} color="text-teal-600" />
          <StatCard icon={Users} label="Developers" value={devCount} color="text-amber-600" />
          <StatCard icon={GitBranch} label="Assignments" value={project.assignments?.length || 0} color="text-emerald-600" />
          <StatCard icon={CheckCircle2} label="Approved" value={totalEpics > 0 ? `${Math.round((approvedEpics / totalEpics) * 100)}%` : '0%'} subtext="of epics" color="text-emerald-600" />
        </div>
      </div>

      <DeveloperTiles project={project} />
      <StoryPointsChart project={project} />
      <StoryDependencies
        project={project}
        onUpdateDependencies={(deps) => updateProject(project.id, { dependencies: deps })}
      />
      <EpicsStories project={project} />
    </div>
  );
}

function SyncedProjectView({ project }) {
  const sprintId = project.jiraSprintId;
  const projectKey = project.jiraProjectKey;
  const kanban = useKanbanSync(projectKey, sprintId);
  const { developers: rosterDevs } = useDevelopers();
  const [assigningKey, setAssigningKey] = useState(null);
  const [assignError, setAssignError] = useState(null);
  const { issues: projectIssues, isLoading: projectIssuesLoading, mutate: mutateProjectIssues } = useProjectIssues(projectKey);
  const { issues: sprintIssues, isLoading: sprintIssuesLoading, mutate: mutateSprintIssues } = useSprintIssues(sprintId);
  // Prefer project-level issues (gets all stories across all sprints); fall back to sprint issues
  const issues = projectIssues.length > 0 ? projectIssues : sprintIssues;
  const issuesLoading = projectKey ? projectIssuesLoading : sprintIssuesLoading;
  const mutateIssues = projectKey ? mutateProjectIssues : mutateSprintIssues;
  const { burndown, isLoading: burndownLoading } = useBurndownData(sprintId);
  const { sprint } = useSprintDetails(sprintId);
  const { alerts } = useAlerts(issues);
  const { syncJiraProgress, updateProject } = useProjects();

  // Sync Jira progress into localStorage whenever issues update
  useEffect(() => {
    if (issues && issues.length > 0) {
      syncJiraProgress(project.id, issues);
    }
  }, [issues, project.id, syncJiraProgress]);

  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;

  const healthData = useMemo(() => {
    // No Jira data yet — fall back to local project health
    if ((!burndown || burndown.length === 0) && (!issues || issues.length === 0)) {
      return computeLocalHealth(project);
    }
    return calculateHealthScore(burndown, issues, totalPoints, totalPoints);
  }, [burndown, issues, totalPoints, project]);

  // Derive stats from Jira issues
  const jiraStats = useMemo(() => {
    if (!issues) return { todo: 0, inProgress: 0, done: 0, total: 0, blockers: 0, bugs: 0, donePoints: 0, totalPoints: 0 };
    let todo = 0, inProgress = 0, done = 0, blockers = 0, bugs = 0, donePoints = 0, tp = 0;
    issues.forEach(i => {
      const s = (i.status || '').toLowerCase();
      const pts = i.storyPoints || 0;
      tp += pts;
      if (s.includes('done') || s.includes('closed') || s.includes('resolved')) { done++; donePoints += pts; }
      else if (s.includes('progress') || s.includes('review')) inProgress++;
      else todo++;
      if (i.priority === 'Blocker' || i.priority === 'Critical') blockers++;
      if ((i.issueType || '').toLowerCase() === 'bug') bugs++;
    });
    return { todo, inProgress, done, total: issues.length, blockers, bugs, donePoints, totalPoints: tp };
  }, [issues]);

  // Build burnup data from burndown
  const burnupData = useMemo(() => {
    if (!burndown || burndown.length === 0) return [];
    const total = burndown[0]?.ideal || totalPoints;
    return burndown.map((pt, i) => ({
      day: pt.day || `Day ${i + 1}`,
      total,
      completed: total - (pt.actual ?? pt.ideal),
      ideal: total - pt.ideal,
    }));
  }, [burndown, totalPoints]);

  // Delayed tasks
  const delayedTasks = useMemo(() => {
    if (!issues) return [];
    return issues.filter(i => {
      const s = (i.status || '').toLowerCase();
      const isBlocked = i.priority === 'Blocker' || i.priority === 'Critical' || (i.labels || []).includes('blocker');
      const isStuck = !s.includes('done') && !s.includes('closed') && !s.includes('resolved');
      return isBlocked && isStuck;
    });
  }, [issues]);

  const completionPct = jiraStats.total > 0 ? Math.round((jiraStats.done / jiraStats.total) * 100) : 0;

  // Velocity estimate
  const velocityInfo = useMemo(() => {
    if (!sprint || !jiraStats.total) return null;
    const startDate = sprint.startDate ? new Date(sprint.startDate) : null;
    const endDate = sprint.endDate ? new Date(sprint.endDate) : null;
    if (!startDate) return null;
    const now = new Date();
    const elapsed = Math.max(1, Math.ceil((now - startDate) / (1000 * 60 * 60 * 24)));
    const dailyRate = jiraStats.done / elapsed;
    const remaining = jiraStats.total - jiraStats.done;
    const daysToFinish = dailyRate > 0 ? Math.ceil(remaining / dailyRate) : null;
    const sprintDays = endDate ? Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) : null;
    return { dailyRate: dailyRate.toFixed(1), daysToFinish, sprintDays, elapsed };
  }, [sprint, jiraStats]);

  // ─── Sprint Completion ───────────────────────────────────────────────────
  const {
    allDone, showCompletionBanner, showCompletionModal, setShowCompletionModal,
    setCompletionDismissed, completing, completionResult, completionError, completeSprint,
  } = useSprintCompletion({ issues, sprint, project });

  const completionReport = useMemo(() => {
    if (!issues || issues.length === 0) return null;
    return buildSprintReport(issues, sprint, healthData);
  }, [issues, sprint, healthData]);

  // After completion: update project in localStorage with analytics metrics
  useEffect(() => {
    if (!completionResult) return;
    if (completionResult.isLastSprint) {
      const metrics = buildCompletionMetrics(project, jiraStats, healthData, completionReport);
      updateProject(project.id, { status: 'completed', completionMetrics: metrics });
    } else if (completionResult.nextSprint) {
      updateProject(project.id, { jiraSprintId: completionResult.nextSprint.id });
    }
  }, [completionResult, project.id, updateProject, jiraStats, healthData, completionReport, project]);

  return (
    <div className="space-y-6">
      {/* Completed Project Summary */}
      {project.status === 'completed' && <CompletedProjectSummary project={project} />}

      {/* Sprint Completion Banner */}
      {showCompletionBanner && (
        <SprintCompletionBanner
          stats={jiraStats}
          onComplete={() => setShowCompletionModal(true)}
          onDismiss={() => setCompletionDismissed(true)}
          isMultiSprint={(project.sprintCount || 1) > 1}
        />
      )}

      {/* Sprint Completion Modal */}
      <SprintCompletionModal
        report={completionReport}
        isOpen={showCompletionModal}
        onClose={() => setShowCompletionModal(false)}
        onComplete={completeSprint}
        completing={completing}
        completionResult={completionResult}
        completionError={completionError}
      />

      {/* Velocity Banner */}
      {velocityInfo && velocityInfo.daysToFinish !== null && (
        <div className="rounded-xl bg-gradient-to-r from-teal-50 to-blue-50 border border-teal-200 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5 text-teal-600" />
            <div>
              <span className="text-sm font-medium text-gray-900">Sprint Velocity: </span>
              <span className="text-sm text-gray-600">{velocityInfo.dailyRate} tasks/day</span>
            </div>
          </div>
          <div className="text-sm text-gray-600">
            {jiraStats.done === jiraStats.total ? (
              <span className="text-emerald-600 font-semibold">All tasks complete!</span>
            ) : (
              <span>~{velocityInfo.daysToFinish} days to finish remaining {jiraStats.total - jiraStats.done} tasks</span>
            )}
          </div>
        </div>
      )}

      {/* Export Row */}
      <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 p-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Sprint Report</h3>
          <p className="text-xs text-gray-500 mt-0.5">Download sprint stats and issue list in PDF, CSV, or JSON format.</p>
        </div>
        <ExportButtons
          report={issues && issues.length > 0 ? {
            sprint: { name: sprint?.name || project.name, startDate: sprint?.startDate, endDate: sprint?.endDate },
            completedIssues: jiraStats.done,
            totalIssues: jiraStats.total,
            completedPoints: jiraStats.donePoints,
            totalPoints: jiraStats.totalPoints,
            healthScore: { score: healthData.score, level: healthData.level },
            issues,
          } : null}
        />
      </div>

      {/* Health Score + Key Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 md:col-span-1">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-5 h-5 text-teal-500" />
            <h3 className="text-sm font-semibold text-gray-900">Sprint Health</h3>
          </div>
          {issuesLoading ? (
            <div className="h-20 flex items-center justify-center text-gray-400 text-sm">Loading Jira data...</div>
          ) : (
            <>
              <HealthBar score={healthData.score} level={healthData.level} />
              {(!issues || issues.length === 0) && (!burndown || burndown.length === 0) && (
                <div className="mt-2 text-[10px] text-amber-600 bg-amber-50 rounded-lg px-2 py-1">
                  Showing local readiness — Jira sprint data not yet available
                </div>
              )}
              <div className="mt-3 space-y-2">
                {healthData.factors?.map((f, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-500">{f.name}</span>
                      <span className="text-[11px] font-mono text-gray-700">{Math.round(f.score)}/{f.max}</span>
                    </div>
                    {f.detail && <div className="text-[10px] text-gray-400 mt-0.5">{f.detail}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="md:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Target} label="Issues" value={jiraStats.total} subtext={`${completionPct}% done`} color="text-teal-600" />
          <StatCard icon={CheckCircle2} label="Completed" value={jiraStats.done} subtext={`${jiraStats.donePoints} pts`} color="text-emerald-600" />
          <StatCard icon={Activity} label="In Progress" value={jiraStats.inProgress} color="text-blue-600" />
          <StatCard icon={Clock} label="To Do" value={jiraStats.todo} color="text-gray-600" />
          <StatCard icon={Flame} label="Blockers" value={jiraStats.blockers} color={jiraStats.blockers > 0 ? 'text-red-600' : 'text-gray-600'} />
          <StatCard icon={Bug} label="Bugs" value={jiraStats.bugs} color={jiraStats.bugs > 0 ? 'text-amber-600' : 'text-gray-600'} />
          <StatCard icon={TrendingUp} label="Points Done" value={jiraStats.donePoints} subtext={`of ${jiraStats.totalPoints}`} color="text-purple-600" />
          <StatCard icon={Users} label="Developers" value={project.analyzedDevelopers?.length || 0} color="text-teal-600" />
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(alert => (
            <div key={alert.id} className={`rounded-xl border p-3 flex items-start gap-3 ${
              alert.severity === 'high' ? 'bg-red-50 border-red-200' :
              alert.severity === 'medium' ? 'bg-amber-50 border-amber-200' :
              'bg-blue-50 border-blue-200'
            }`}>
              <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${
                alert.severity === 'high' ? 'text-red-500' : alert.severity === 'medium' ? 'text-amber-500' : 'text-blue-500'
              }`} />
              <div>
                <div className={`text-sm font-medium ${
                  alert.severity === 'high' ? 'text-red-700' : alert.severity === 'medium' ? 'text-amber-700' : 'text-blue-700'
                }`}>{alert.title}</div>
                {alert.message && <div className="text-xs text-gray-600 mt-0.5">{alert.message}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Burndown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-teal-500" /> Burndown Chart
          </h3>
          <p className="text-[11px] text-gray-400 mb-4">Tracks remaining work (story points) over time vs. the ideal pace. The gap between lines shows if the sprint is ahead or behind schedule.</p>
          {burndownLoading ? (
            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">Loading...</div>
          ) : burndown && burndown.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={burndown}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} label={{ value: 'Story Points Remaining', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#9ca3af' } }} />
                <Tooltip {...chartTooltip} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="ideal" stroke="#9ca3af" fill="#f3f4f6" strokeDasharray="5 5" name="Ideal Remaining" dot={{ r: 3, fill: '#9ca3af' }} />
                <Area type="monotone" dataKey="actual" stroke="#0d9488" fill="#ccfbf1" name="Actual Remaining" dot={{ r: 3, fill: '#0d9488' }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex flex-col items-center justify-center text-center px-4">
              <TrendingDown className="w-8 h-8 text-gray-200 mb-2" />
              <div className="text-sm text-gray-400">No burndown data yet</div>
              <div className="text-[11px] text-gray-300 mt-1">This chart will show remaining story points declining day-by-day once the sprint is active in Jira</div>
            </div>
          )}
        </div>

        {/* Burnup */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-purple-500" /> Burnup Chart
          </h3>
          <p className="text-[11px] text-gray-400 mb-4">Tracks completed work rising toward total scope. Shows scope changes (expanding top line) and delivery progress (rising bottom line).</p>
          {burndownLoading ? (
            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">Loading...</div>
          ) : burnupData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={burnupData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} label={{ value: 'Story Points', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#9ca3af' } }} />
                <Tooltip {...chartTooltip} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="total" stroke="#9ca3af" fill="#f3f4f6" name="Total Scope" dot={{ r: 3, fill: '#9ca3af' }} />
                <Area type="monotone" dataKey="ideal" stroke="#d1d5db" fill="none" strokeDasharray="5 5" name="Ideal Progress" dot={{ r: 3, fill: '#d1d5db' }} />
                <Area type="monotone" dataKey="completed" stroke="#7c3aed" fill="#ede9fe" name="Work Completed" dot={{ r: 3, fill: '#7c3aed' }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex flex-col items-center justify-center text-center px-4">
              <TrendingUp className="w-8 h-8 text-gray-200 mb-2" />
              <div className="text-sm text-gray-400">No burnup data yet</div>
              <div className="text-[11px] text-gray-300 mt-1">This chart will show completed work rising toward total scope once the sprint is active in Jira</div>
            </div>
          )}
        </div>
      </div>

      {/* Developer Workload */}
      {project.analyzedDevelopers?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Users className="w-4 h-4 text-teal-500" /> Developer Workload
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {project.analyzedDevelopers.map(dev => {
              // Match issues by: Jira display name, email, accountId, or GitHub username
              const jiraName = dev.jiraUsername || '';
              const devIssues = (issues || []).filter(i => {
                if (!i.assignee) return false;
                const aName = (i.assignee.name || '').toLowerCase();
                const aEmail = (i.assignee.emailAddress || '').toLowerCase();
                const aId = i.assignee.accountId || '';
                const uname = dev.username.toLowerCase();
                const jira = jiraName.toLowerCase();
                return aName === uname || aName === jira
                  || (jira && aEmail === jira)
                  || aName.includes(uname) || uname.includes(aName.split(' ')[0]?.toLowerCase() || '')
                  || (aId && aId === dev.jiraAccountId);
              });
              const devDone = devIssues.filter(i => {
                const s = (i.status || '').toLowerCase();
                return s.includes('done') || s.includes('closed') || s.includes('resolved');
              }).length;
              const devTotal = devIssues.length;
              const pct = devTotal > 0 ? Math.round((devDone / devTotal) * 100) : 0;

              return (
                <div key={dev.username} className="rounded-xl border border-gray-200 p-3">
                  <div className="flex items-center gap-2.5 mb-2">
                    <img
                      src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                      alt={dev.username}
                      className="w-8 h-8 rounded-lg ring-1 ring-gray-200"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">{dev.username}</div>
                      <div className="text-[10px] text-gray-400">{dev.primary_expertise || dev.analysis?.expertise?.primary || 'Dev'}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-500">{devDone}/{devTotal} tasks</span>
                    <span className="font-semibold text-gray-700">{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-teal-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Delayed / Blocked Tasks */}
      {delayedTasks.length > 0 && (
        <div className="bg-white rounded-xl border border-red-200 p-5">
          <h3 className="text-sm font-semibold text-red-700 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Blocked / Critical Tasks ({delayedTasks.length})
          </h3>
          {assignError && (
            <div className="mb-2 rounded-lg bg-red-100 border border-red-300 px-3 py-2 text-xs text-red-700 flex items-center justify-between">
              <span>{assignError}</span>
              <button onClick={() => setAssignError(null)} className="text-red-500 hover:text-red-700 ml-2 font-bold">×</button>
            </div>
          )}
          <div className="space-y-2">
            {delayedTasks.map(task => (
              <div key={task.key} className="flex items-center gap-3 rounded-lg bg-red-50 p-3">
                <Flame className="w-4 h-4 text-red-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">{task.summary}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{task.key} · {task.assignee?.name || 'Unassigned'} · {task.priority}</div>
                </div>
                <select
                  value=""
                  disabled={assigningKey === task.key}
                  onChange={async (e) => {
                    const jiraUsername = e.target.value;
                    if (!jiraUsername) return;
                    setAssigningKey(task.key);
                    setAssignError(null);
                    try {
                      const res = await apiFetch(`/api/jira/issue/${task.key}/assign`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jiraQuery: jiraUsername }),
                      });
                      if (!res.ok) {
                        const data = await res.json();
                        throw new Error(data.error || 'Assignment failed');
                      }
                      mutateIssues();
                    } catch (err) {
                      setAssignError(`${task.key}: ${err.message}`);
                    } finally {
                      setAssigningKey(null);
                    }
                  }}
                  className="rounded-lg border border-gray-200 bg-white text-xs text-gray-700 pl-2 pr-6 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400 focus:border-red-400 shrink-0"
                >
                  <option value="">{assigningKey === task.key ? 'Assigning...' : task.assignee ? 'Reassign' : 'Assign'}</option>
                  {rosterDevs.filter(d => d.jiraUsername).map(d => (
                    <option key={d.username} value={d.jiraUsername}>{d.username}</option>
                  ))}
                </select>
                <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${
                  task.priority === 'Blocker' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>{task.priority}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interactive Kanban — 2-way sync with Jira */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div />
          <Link
            to={`/projects/${project.id}/kanban`}
            className="text-xs text-teal-600 hover:text-teal-700 flex items-center gap-1 font-medium"
          >
            Full Board <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <KanbanBoard kanban={kanban} variant="mini" title="Sprint Kanban" />
      </div>

      {/* Team Standup Reports */}
      {projectKey && <ProjectStandupReports projectKey={projectKey} />}

      {/* Story Points + Epics & Stories */}
      <StoryPointsChart project={project} />
      <StoryDependencies
        project={project}
        onUpdateDependencies={(deps) => updateProject(project.id, { dependencies: deps })}
      />
      <EpicsStories project={project} />

      {/* Sprint Retrospective */}
      <SprintRetro projectId={project.id} />
    </div>
  );
}

function ProjectStandupReports({ projectKey }) {
  const [standups, setStandups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [show, setShow] = useState(true);

  const fetchStandups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/standup/history?project_key=${projectKey}`);
      const data = await res.json();
      if (data.success) setStandups(data.standups || []);
      else setError(data.error || 'Failed to load');
    } catch {
      setError('Standup bot not running.');
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => { if (show) fetchStandups(); }, [show, fetchStandups]);

  const blockerCount = standups.filter(s => s.is_blocker).length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-500" />
          Team Standup Reports
          {standups.length > 0 && (
            <span className="text-[10px] font-normal text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{standups.length}</span>
          )}
          {blockerCount > 0 && (
            <span className="text-[10px] font-medium text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded-full">{blockerCount} blocker{blockerCount > 1 ? 's' : ''}</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={fetchStandups} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button onClick={() => setShow(p => !p)} className="text-[10px] text-gray-400 hover:text-gray-600">
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {show && (
        <>
          {error && <p className="text-xs text-rose-500 mb-2">{error}</p>}
          {loading ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="animate-pulse rounded-lg border border-gray-100 p-3">
                  <div className="flex items-center gap-2"><div className="h-6 w-6 rounded-full bg-gray-200" /><div className="h-3 w-24 bg-gray-200 rounded" /></div>
                </div>
              ))}
            </div>
          ) : standups.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No standup reports for {projectKey} yet. Team members can submit via /standup in Slack.</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {standups.map((s, i) => {
                const isOpen = expanded === i;
                const ts = s.timestamp ? new Date(s.timestamp) : null;
                const sentimentColor = s.sentiment === 'Positive' ? 'text-emerald-500' : s.sentiment === 'Negative' ? 'text-rose-500' : 'text-amber-500';

                return (
                  <div
                    key={i}
                    className={`rounded-lg border ${s.is_blocker ? 'border-rose-200 bg-rose-50/30' : 'border-gray-100'} p-3 cursor-pointer hover:bg-gray-50/50 transition-colors`}
                    onClick={() => setExpanded(isOpen ? null : i)}
                  >
                    <div className="flex items-center gap-2">
                      {s.avatar ? (
                        <img src={s.avatar} className="h-6 w-6 rounded-full" alt="" />
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600">
                          {(s.user_name || s.user_id || '?')[0]?.toUpperCase()}
                        </div>
                      )}
                      <span className="text-xs font-semibold text-gray-800">{s.user_name || s.user_id || 'Unknown'}</span>
                      {s.is_blocker && <span className="text-[10px] font-medium text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded"><Shield className="h-2.5 w-2.5 inline" /> Blocker</span>}
                      <span className="ml-auto text-[10px] text-gray-400">{ts ? ts.toLocaleString() : ''}</span>
                      <ChevronDown className={`h-3 w-3 text-gray-300 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </div>
                    {!isOpen && <p className="text-[11px] text-gray-500 mt-1 truncate">{s.today || s.ai_summary_today || s.yesterday || s.ai_summary_yesterday || ''}</p>}
                    {isOpen && (
                      <div className="mt-3 pt-2 border-t border-gray-100 space-y-2 text-xs">
                        <div><span className="font-semibold text-gray-500">Yesterday:</span> <span className="text-gray-700">{s.yesterday || s.ai_summary_yesterday || '-'}</span></div>
                        <div><span className="font-semibold text-gray-500">Today:</span> <span className="text-gray-700">{s.today || s.ai_summary_today || '-'}</span></div>
                        {s.blocker && s.blocker !== 'None' && (
                          <div><span className="font-semibold text-gray-500">Blockers:</span> <span className="text-gray-700">{s.blocker}</span></div>
                        )}
                        {s.is_blocker && s.blocker_details && (
                          <div className="rounded-lg bg-rose-50 border border-rose-200 p-2">
                            <p className="font-semibold text-rose-600 text-[10px] uppercase mb-1">Blocker</p>
                            <p className="text-rose-700">Type: {s.blocker_details.type} | Impact: {s.blocker_details.impact}</p>
                            {s.blocker_details.recommendation && <p className="text-rose-700">Recommendation: {s.blocker_details.recommendation}</p>}
                          </div>
                        )}
                        <div className="flex gap-4 text-[10px] text-gray-400">
                          {s.finished_tickets?.length > 0 && <span>Done: {s.finished_tickets.join(', ')}</span>}
                          {s.today_tickets?.length > 0 && <span>Working on: {s.today_tickets.join(', ')}</span>}
                          <span className={sentimentColor}>Sentiment: {s.sentiment}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

class DetailErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8 text-red-600">
          <h2 className="text-lg font-bold mb-2">Something went wrong</h2>
          <pre className="text-sm whitespace-pre-wrap">{this.state.error.message}</pre>
          <pre className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ProjectDetailPage() {
  return (
    <DetailErrorBoundary>
      <ProjectDetailPageInner />
    </DetailErrorBoundary>
  );
}

function ProjectDetailPageInner() {
  const { projectId } = useParams();
  const { getProject, isLoaded } = useProjects();
  const navigate = useNavigate();
  const project = getProject(projectId);

  useEffect(() => {
    if (isLoaded && !project) navigate('/projects');
  }, [isLoaded, project, navigate]);

  if (!isLoaded || !project) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-500 border-t-transparent" />
      </div>
    );
  }

  const cfg = statusConfig[project.status] || { label: project.status, color: 'bg-gray-100 text-gray-600' };
  const totalStories = project.epics?.reduce((s, e) => s + (e.stories?.length || 0), 0) || 0;
  const totalPoints = project.epics?.reduce((s, e) =>
    s + (e.stories?.reduce((ss, st) => ss + (st.storyPoints || 0), 0) || 0), 0) || 0;

  const deadline = project.deadline ? (() => {
    const { value, unit } = project.deadline;
    if (!value) return null;
    const created = project.createdAt ? new Date(project.createdAt) : new Date();
    const end = new Date(created);
    const v = parseInt(value);
    switch (unit) {
      case 'hours': end.setHours(end.getHours() + v); break;
      case 'days': end.setDate(end.getDate() + v); break;
      case 'months': end.setMonth(end.getMonth() + v); break;
      default: end.setDate(end.getDate() + v * 7); break;
    }
    const daysLeft = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
    return { endDate: end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), daysLeft };
  })() : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Back link */}
      <Link to="/projects" className="mb-6 inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Projects
      </Link>

      {/* Project Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
              {project.jiraProjectKey && (
                <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-mono font-medium text-blue-600">{project.jiraProjectKey}</span>
              )}
            </div>
            {(project.rawText || project.description) && (
              <ProjectDescription text={project.rawText || project.description} project={project} />
            )}
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
              <span>{project.epics?.length || 0} epics · {totalStories} stories · {totalPoints} points</span>
              {project.createdAt && (
                <span className="flex items-center gap-1 text-gray-400">
                  <Clock className="w-3.5 h-3.5" />
                  Created {new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              )}
              {deadline && (
                <span className={`flex items-center gap-1 ${deadline.daysLeft < 0 ? 'text-red-600' : deadline.daysLeft <= 3 ? 'text-amber-600' : ''}`}>
                  <Calendar className="w-3.5 h-3.5" />
                  {deadline.endDate} ({deadline.daysLeft < 0 ? `${Math.abs(deadline.daysLeft)}d overdue` : `${deadline.daysLeft}d left`})
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!project.status || project.status === 'epics-ready' ? (
              <Link
                to={`/projects/${projectId}/verify`}
                className="inline-flex items-center gap-2 rounded-xl bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 transition-all"
              >
                <ClipboardCheck className="h-4 w-4" /> Verify Epics
              </Link>
            ) : project.status === 'stories-ready' ? (
              <Link
                to={`/projects/${projectId}/assign`}
                className="inline-flex items-center gap-2 rounded-xl bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 transition-all"
              >
                <UserPlus className="h-4 w-4" /> Assign Developers
              </Link>
            ) : project.status === 'assigned' ? (
              <Link
                to={`/projects/${projectId}/assign`}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 transition-all"
              >
                <ExternalLink className="h-4 w-4" /> Sync to Jira
              </Link>
            ) : null}
            {(project.status === 'synced' || project.status === 'completed') && (
              <>
                <Link
                  to="/dashboard"
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all"
                >
                  <LayoutDashboard className="h-4 w-4" /> Dashboard
                </Link>
                <Link
                  to={`/projects/${projectId}/kanban`}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all"
                >
                  <Columns3 className="h-4 w-4" /> Kanban
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Content: different view for synced vs non-synced */}
      {(project.status === 'synced' || project.status === 'completed') && (project.jiraSprintId || project.jiraProjectKey) ? (
        <SyncedProjectView project={project} />
      ) : (
        <LocalProjectView project={project} />
      )}
    </div>
  );
}
