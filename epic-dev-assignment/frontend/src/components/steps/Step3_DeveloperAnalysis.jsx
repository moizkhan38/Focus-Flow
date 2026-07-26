import { useState, useMemo, useEffect } from 'react';
import { apiFetch, humanizeError } from '../../lib/api.js';
import { useWorkflow } from '../../context/WorkflowContext';
import { useDevelopers } from '../../hooks/useDevelopers';
import { useProjects } from '../../hooks/useProjects';
import { useIntegrations } from '../../hooks/useIntegrations';
import NotConnected from '../shared/NotConnected';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Users, Loader2, ChevronDown, Check, UserPlus } from 'lucide-react';
import { SkeletonDevCard } from '../shared/Skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';

const COLORS = ['#34D399', '#F87171'];
const FILE_COLORS = ['#0EA5B0', '#7C5DC7', '#34D399', '#B45309', '#F87171', '#6B7280', '#14B8A6', '#818CF8'];

const toneColors = {
  purple: { bg: 'bg-purple-100', text: 'text-purple-700' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-700' },
  green: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  yellow: { bg: 'bg-amber-100', text: 'text-amber-700' },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: (i) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: [0.16, 1, 0.3, 1] }
  })
};

const chartGrid = '#e5e7eb';
const chartTick = { fontSize: 10, fill: '#9ca3af' };
const chartTooltip = {
  contentStyle: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '10px', fontSize: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.08)'
  },
  itemStyle: { color: '#1f2937' },
  labelStyle: { color: '#6b7280' }
};

const inputCls = "w-full rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all";

export default function Step3_DeveloperAnalysis() {
  const { developers, setDevelopers, nextStep, previousStep } = useWorkflow();
  const { developers: rosterDevs, addDevelopers: addToRoster } = useDevelopers();
  const { projects } = useProjects();

  // Collect developers from existing projects and merge into roster on mount
  useEffect(() => {
    const projectDevs = [];
    for (const p of projects) {
      if (p.analyzedDevelopers?.length > 0) {
        for (const dev of p.analyzedDevelopers) {
          if (dev.username && !rosterDevs.some(r => r.username === dev.username)) {
            if (!projectDevs.some(d => d.username === dev.username)) {
              projectDevs.push(dev);
            }
          }
        }
      }
    }
    if (projectDevs.length > 0) {
      addToRoster(projectDevs);
    }
  }, [projects.length]); // Only run when project count changes

  const [selectedRoster, setSelectedRoster] = useState(() => {
    const set = new Set();
    for (const d of developers) {
      if (rosterDevs.some((r) => r.username === d.username)) {
        set.add(d.username);
      }
    }
    return set;
  });

  // Compute existing workload per developer across all projects
  const devWorkloadMap = useMemo(() => {
    const map = {};
    for (const p of projects) {
      if (!p.assignments || p.assignments.length === 0) continue;
      for (const a of p.assignments) {
        const username = a.assigned_developer || a.developer?.username;
        if (!username) continue;
        if (!map[username]) map[username] = { stories: 0, points: 0, projects: new Set() };
        map[username].stories += 1;
        map[username].points += (a.story_points || a.storyPoints || 0);
        map[username].projects.add(p.id || p.name);
      }
    }
    const result = {};
    for (const [username, data] of Object.entries(map)) {
      result[username] = { stories: data.stories, points: data.points, projectCount: data.projects.size };
    }
    return result;
  }, [projects]);

  const { github, isLoading: integrationsLoading } = useIntegrations();
  // Analyzing reads commit history through the org's own GitHub token.
  const githubBlocked = !integrationsLoading && !github?.connected;

  const [showNewForm, setShowNewForm] = useState(false);
  const [devInputs, setDevInputs] = useState([{ username: '', owner: '', repo: '', jiraEmail: '' }]);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [error, setError] = useState(null);
  const [expandedDev, setExpandedDev] = useState(null);

  const [freshAnalyzed, setFreshAnalyzed] = useState(() => {
    return developers.filter((d) => !rosterDevs.some((r) => r.username === d.username));
  });

  const mergedDevelopers = useMemo(() => {
    const selected = rosterDevs.filter((r) => selectedRoster.has(r.username));
    const seen = new Set();
    const merged = [];
    for (const d of selected) {
      if (!seen.has(d.username)) { merged.push(d); seen.add(d.username); }
    }
    for (const d of freshAnalyzed) {
      if (!seen.has(d.username)) { merged.push(d); seen.add(d.username); }
    }
    return merged;
  }, [rosterDevs, selectedRoster, freshAnalyzed]);

  const toggleRosterDev = (username) => {
    setSelectedRoster((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const addDeveloperInput = () => {
    setDevInputs([...devInputs, { username: '', owner: '', repo: '', jiraEmail: '' }]);
  };

  const removeDeveloperInput = (index) => {
    setDevInputs(devInputs.filter((_, i) => i !== index));
  };

  const updateDeveloperInput = (index, field, value) => {
    const updated = [...devInputs];
    updated[index][field] = value;
    setDevInputs(updated);
  };

  const handleAnalyze = async () => {
    const validInputs = devInputs.filter(d => d.username.trim());
    if (validInputs.length === 0) {
      setError('Please enter at least one GitHub username');
      return;
    }

    const toAnalyze = validInputs.filter(
      (d) => !rosterDevs.some((r) => r.username === d.username.trim())
    );
    const alreadyInRoster = validInputs.filter(
      (d) => rosterDevs.some((r) => r.username === d.username.trim())
    );

    if (alreadyInRoster.length > 0) {
      setSelectedRoster((prev) => {
        const next = new Set(prev);
        alreadyInRoster.forEach((d) => next.add(d.username.trim()));
        return next;
      });
    }

    if (toAnalyze.length === 0) {
      setDevInputs([{ username: '', owner: '', repo: '' }]);
      setShowNewForm(false);
      return;
    }

    setLoading(true);
    setError(null);
    setLoadingProgress('Connecting to GitHub...');

    const progressSteps = [
      { delay: 3000, msg: 'Fetching repositories...' },
      { delay: 8000, msg: 'Analyzing commit history...' },
      { delay: 15000, msg: 'Detecting expertise from file patterns...' },
      { delay: 25000, msg: 'Calculating experience levels...' },
      { delay: 40000, msg: 'Processing detailed commit data...' },
      { delay: 60000, msg: 'Almost done, finalizing analysis...' },
    ];
    const timers = progressSteps.map(({ delay, msg }) =>
      setTimeout(() => setLoadingProgress(msg), delay)
    );

    try {
      const response = await apiFetch('/api/analyze-developers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ developers: toAnalyze })
      });

      const text = await response.text();
      if (!text) throw new Error('Empty response from server. Please try again.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid response from server. Please try again.'); }
      if (!data.success) throw new Error(data.error || 'Failed to analyze developers');

      if (data.developers.length === 0 && alreadyInRoster.length === 0) {
        setError('No developers could be analyzed. Check usernames and try again.');
      } else {
        // Merge Jira emails from the form inputs
        const jiraMap = {};
        for (const d of validInputs) {
          if (d.jiraEmail?.trim()) jiraMap[d.username.trim()] = d.jiraEmail.trim();
        }
        const enriched = data.developers.map((dev) => ({
          ...dev,
          jiraUsername: jiraMap[dev.username] || dev.jiraUsername || '',
        }));

        // Persist to roster so they appear on future visits
        if (enriched.length > 0) {
          addToRoster(enriched);
        }
        setFreshAnalyzed((prev) => {
          const seen = new Set(prev.map((d) => d.username));
          const added = enriched.filter((d) => !seen.has(d.username));
          return [...prev, ...added];
        });
        setDevInputs([{ username: '', owner: '', repo: '', jiraEmail: '' }]);
        setShowNewForm(false);
      }
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      timers.forEach(clearTimeout);
      setLoading(false);
      setLoadingProgress('');
    }
  };

  const handleProceed = () => {
    if (mergedDevelopers.length === 0) {
      setError('Please select or analyze at least one developer before proceeding');
      return;
    }
    setDevelopers(mergedDevelopers);
    nextStep();
  };

  const removeFreshDev = (username) => {
    setFreshAnalyzed((prev) => prev.filter((d) => d.username !== username));
  };

  const toggleExpand = (index) => {
    setExpandedDev(expandedDev === index ? null : index);
  };

  const allDisplayDevs = mergedDevelopers;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Roster Selection */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-teal-500" />
            Select from Team Roster
          </h2>
          <p className="text-gray-500 text-sm mt-1">
            {rosterDevs.length > 0
              ? 'These developers are already analyzed. Click to select them for this project.'
              : 'No developers in your roster yet. Analyze developers below to build your team.'}
          </p>
        </div>

        {rosterDevs.length > 0 ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {rosterDevs.map((dev) => {
                const isSelected = selectedRoster.has(dev.username);
                const workload = devWorkloadMap[dev.username] || { stories: 0, points: 0, projectCount: 0 };
                return (
                  <motion.button
                    key={dev.username}
                    onClick={() => toggleRosterDev(dev.username)}
                    className={`flex items-center gap-3 rounded-xl p-3 text-left transition-all duration-200 border ${
                      isSelected
                        ? 'bg-teal-50 border-teal-300'
                        : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                    }`}
                    whileTap={{ scale: 0.98 }}
                  >
                    <div className="relative">
                      <img
                        src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                        alt={dev.username}
                        className="w-10 h-10 rounded-lg ring-1 ring-gray-200"
                      />
                      {isSelected && (
                        <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">{dev.username}</span>
                        {dev.experience_level && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                            {dev.experience_level}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 truncate block">
                        {dev.primary_expertise || 'Full Stack'}
                        {dev.jiraUsername ? ` · ${dev.jiraUsername}` : ''}
                      </span>
                      {workload.stories > 0 ? (
                        <span className="text-[10px] text-amber-600 font-medium mt-0.5 block">
                          {workload.stories} {workload.stories === 1 ? 'story' : 'stories'} ({workload.points} SP) across {workload.projectCount} {workload.projectCount === 1 ? 'project' : 'projects'}
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-500 font-medium mt-0.5 block">No current assignments</span>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </div>

            <div className="text-xs text-gray-400">
              {selectedRoster.size} of {rosterDevs.length} selected
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 py-8">
            <div className="text-center">
              <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-400">Your team roster is empty</p>
              <p className="text-xs text-gray-400 mt-1">Analyze a developer below to add them to your roster</p>
            </div>
          </div>
        )}
      </div>

      {/* Analyze New Developers */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-teal-500" />
              {rosterDevs.length > 0 ? 'Analyze New Developer' : 'Analyze Developers'}
            </h2>
            <p className="text-gray-500 text-sm mt-1">
              {rosterDevs.length > 0
                ? 'Add a new developer not yet in your roster'
                : 'Enter GitHub usernames to analyze developer expertise from commit history'}
            </p>
          </div>
          {rosterDevs.length > 0 && !showNewForm && (
            <motion.button
              onClick={() => setShowNewForm(true)}
              className="text-sm font-medium text-gray-600 rounded-xl border border-gray-200 px-3 py-2 hover:bg-gray-50 flex items-center gap-1.5 transition-all"
              whileTap={{ scale: 0.95 }}
            >
              <Plus className="w-4 h-4" /> Add New
            </motion.button>
          )}
        </div>

        {(showNewForm || rosterDevs.length === 0) && (
          <>
            {githubBlocked && (
              <div className="mb-3">
                <NotConnected provider="github" compact />
              </div>
            )}
            <div className="space-y-3">
              {devInputs.map((dev, index) => (
                <motion.div
                  key={index}
                  className="flex flex-col gap-2 sm:flex-row"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                >
                  <input
                    type="text"
                    placeholder="GitHub Username *"
                    value={dev.username}
                    onChange={(e) => updateDeveloperInput(index, 'username', e.target.value)}
                    className={inputCls + " flex-1"}
                    disabled={loading}
                  />
                  <input
                    type="text"
                    placeholder="Owner (optional)"
                    value={dev.owner}
                    onChange={(e) => updateDeveloperInput(index, 'owner', e.target.value)}
                    className={inputCls + " flex-1"}
                    disabled={loading}
                  />
                  <input
                    type="text"
                    placeholder="Repository (optional)"
                    value={dev.repo}
                    onChange={(e) => updateDeveloperInput(index, 'repo', e.target.value)}
                    className={inputCls + " flex-1"}
                    disabled={loading}
                  />
                  <input
                    type="text"
                    placeholder="Jira Email (optional)"
                    value={dev.jiraEmail}
                    onChange={(e) => updateDeveloperInput(index, 'jiraEmail', e.target.value)}
                    className={inputCls + " flex-1"}
                    disabled={loading}
                  />
                  {devInputs.length > 1 && (
                    <motion.button
                      onClick={() => removeDeveloperInput(index)}
                      disabled={loading}
                      className="w-10 h-10 self-end rounded-xl bg-red-50 text-red-500 hover:bg-red-100 transition-colors flex items-center justify-center shrink-0 sm:self-auto"
                      whileTap={{ scale: 0.9 }}
                    >
                      <X className="w-4 h-4" />
                    </motion.button>
                  )}
                </motion.div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={addDeveloperInput}
                disabled={loading || devInputs.length >= 10}
                className="text-sm font-medium text-gray-600 rounded-xl border border-gray-200 px-3 py-2.5 hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1.5 transition-all"
              >
                <Plus className="w-4 h-4" /> Add Developer
              </button>
              <motion.button
                onClick={handleAnalyze}
                disabled={loading}
                className="flex-1 text-sm font-semibold bg-teal-500 text-white rounded-xl px-6 py-2.5
                           hover:bg-teal-600 active:scale-[0.98] transition-all
                           disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                whileTap={{ scale: 0.98 }}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> {loadingProgress || 'Analyzing developers...'}
                  </span>
                ) : (
                  'Analyze & Add'
                )}
              </motion.button>
            </div>
          </>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 rounded-xl bg-red-50 border border-red-200"
          >
            <p className="text-red-600 text-sm">{error}</p>
          </motion.div>
        )}
      </div>

      {/* Loading skeletons */}
      {loading && allDisplayDevs.length === 0 && (
        <div className="space-y-3">
          {devInputs.filter(d => d.username.trim()).map((_, i) => (
            <SkeletonDevCard key={i} />
          ))}
        </div>
      )}

      {/* Results */}
      {allDisplayDevs.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-gray-400 text-xs font-mono uppercase tracking-wider">
            Selected Developers ({allDisplayDevs.length})
          </h3>

          {allDisplayDevs.map((dev, index) => {
            const tone = toneColors[dev.analysis?.experienceLevel?.tone] || toneColors.blue;
            const isFromRoster = rosterDevs.some((r) => r.username === dev.username);

            return (
              <motion.div
                key={dev.username}
                custom={index}
                variants={cardVariants}
                initial="hidden"
                animate="show"
              >
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  {/* Summary */}
                  <div className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap sm:gap-4">
                      <img
                        src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                        alt={dev.username}
                        className="w-12 h-12 shrink-0 rounded-xl ring-1 ring-gray-200 sm:w-14 sm:h-14"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <h4 className="font-semibold text-gray-900">{dev.username}</h4>
                          {isFromRoster && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-teal-100 text-teal-700">
                              From Roster
                            </span>
                          )}
                          {dev.jiraUsername ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-50 text-blue-600">
                              Jira: {dev.jiraUsername}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-amber-50 text-amber-600">
                              No Jira email
                            </span>
                          )}
                          {dev.analysis?.experienceLevel && (
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono ${tone.bg} ${tone.text}`}>
                              {dev.analysis.experienceLevel.level}
                            </span>
                          )}
                          {dev.analysis?.expertise && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-gray-100 text-gray-500">
                              {dev.analysis.expertise.primaryIcon} {dev.analysis.expertise.primary}
                            </span>
                          )}
                        </div>

                        {dev.analysis?.totalCommits != null && (
                          <div className="grid grid-cols-2 gap-3 mt-3 sm:grid-cols-4 sm:gap-4">
                            {[
                              { label: 'Commits', value: dev.analysis.totalCommits },
                              { label: 'On-Time', value: `${dev.analysis.onTimePercentage}%` },
                              { label: 'Consistency', value: dev.analysis.consistencyScore },
                              { label: 'Avg Size', value: `${dev.analysis.avgCommitSize} ln` },
                            ].map((stat, i) => (
                              <div key={i}>
                                <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-0.5">{stat.label}</div>
                                <div className="text-sm font-semibold text-gray-900">{stat.value}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {dev.analysis?.expertise?.all && (
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {dev.analysis.expertise.all.slice(0, 4).map((exp, i) => (
                              <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-gray-100 text-gray-500">
                                {exp.icon} {exp.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0 ml-auto sm:ml-0">
                        {dev.analysis?.totalCommits != null && (
                          <motion.button
                            onClick={() => toggleExpand(index)}
                            className="text-xs py-1.5 px-3 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 flex items-center gap-1 transition-all"
                            whileTap={{ scale: 0.95 }}
                          >
                            {expandedDev === index ? 'Hide' : 'Details'}
                            <motion.div animate={{ rotate: expandedDev === index ? 180 : 0 }}>
                              <ChevronDown className="w-3 h-3" />
                            </motion.div>
                          </motion.button>
                        )}
                        {!isFromRoster && (
                          <motion.button
                            onClick={() => removeFreshDev(dev.username)}
                            className="text-xs py-1.5 px-3 rounded-lg font-medium text-red-400 bg-gray-100 hover:text-red-600 hover:bg-red-50 transition-all"
                            whileTap={{ scale: 0.95 }}
                          >
                            <X className="w-3 h-3" />
                          </motion.button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Charts */}
                  <AnimatePresence>
                    {expandedDev === index && dev.analysis && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="px-3 pb-5 pt-5 space-y-5 border-t border-gray-100 sm:px-5">
                          {/* Experience banner */}
                          <div className="rounded-2xl bg-gradient-to-r from-teal-50 to-purple-50 border border-gray-200 p-5">
                            <div className="text-xs font-mono uppercase tracking-wider text-gray-400 mb-2">Experience Level</div>
                            <div className="text-xl font-bold text-gray-900 mb-3">{dev.analysis.experienceLevel.level}</div>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-0.5">Lines Changed</div>
                                <div className="text-sm font-semibold">
                                  <span className="text-emerald-600">+{dev.analysis.totalLinesAdded.toLocaleString()}</span>
                                  {' / '}
                                  <span className="text-red-500">-{dev.analysis.totalLinesDeleted.toLocaleString()}</span>
                                </div>
                              </div>
                              <div>
                                <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-0.5">Avg Commit Size</div>
                                <div className="text-sm font-semibold text-gray-900">{dev.analysis.avgCommitSize} lines</div>
                              </div>
                            </div>
                          </div>

                          {/* Chart row 1 */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <ChartCard title="File Types">
                              <ResponsiveContainer width="100%" height={200}>
                                <PieChart>
                                  <Pie data={dev.analysis.fileTypes} cx="50%" cy="50%" labelLine={false}
                                    label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                                    outerRadius={65} fill="#8884d8" dataKey="value"
                                  >
                                    {dev.analysis.fileTypes.map((_, i) => (
                                      <Cell key={`cell-${i}`} fill={FILE_COLORS[i % FILE_COLORS.length]} />
                                    ))}
                                  </Pie>
                                  <Tooltip {...chartTooltip} />
                                </PieChart>
                              </ResponsiveContainer>
                            </ChartCard>

                            <ChartCard title="Commit Sizes">
                              <ResponsiveContainer width="100%" height={200}>
                                <BarChart data={dev.analysis.commitSizeDistribution}>
                                  <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                                  <XAxis dataKey="range" tick={chartTick} />
                                  <YAxis tick={chartTick} />
                                  <Tooltip {...chartTooltip} />
                                  <Bar dataKey="count" fill="#0EA5B0" radius={[4, 4, 0, 0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </ChartCard>

                            <ChartCard title="Commit Frequency">
                              <ResponsiveContainer width="100%" height={200}>
                                <LineChart data={dev.analysis.consistencyTimeline}>
                                  <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                                  <XAxis dataKey="commit" tick={chartTick} />
                                  <YAxis tick={chartTick} />
                                  <Tooltip {...chartTooltip} />
                                  <Line type="monotone" dataKey="days" stroke="#7C5DC7" strokeWidth={2} dot={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            </ChartCard>
                          </div>

                          {/* Chart row 2 */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <ChartCard title="On-Time vs Late">
                              <ResponsiveContainer width="100%" height={220}>
                                <PieChart>
                                  <Pie
                                    data={[
                                      { name: 'On-Time', value: dev.analysis.onTimeCount },
                                      { name: 'Late', value: dev.analysis.lateCount },
                                    ]}
                                    cx="50%" cy="50%" labelLine={false}
                                    label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                                    outerRadius={80} fill="#8884d8" dataKey="value"
                                  >
                                    {COLORS.map((color, i) => (
                                      <Cell key={`cell-${i}`} fill={color} />
                                    ))}
                                  </Pie>
                                  <Tooltip {...chartTooltip} />
                                </PieChart>
                              </ResponsiveContainer>
                            </ChartCard>

                            <ChartCard title="Weekday Activity">
                              <ResponsiveContainer width="100%" height={220}>
                                <BarChart data={dev.analysis.weekdayData}>
                                  <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                                  <XAxis dataKey="day" tick={chartTick} />
                                  <YAxis tick={chartTick} />
                                  <Tooltip {...chartTooltip} />
                                  <Bar dataKey="commits" fill="#34D399" radius={[4, 4, 0, 0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </ChartCard>
                          </div>

                          {/* Hourly */}
                          <ChartCard title="Hourly Activity">
                            <ResponsiveContainer width="100%" height={220}>
                              <BarChart data={dev.analysis.hourlyData}>
                                <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                                <XAxis dataKey="hour" tick={chartTick} angle={-45} textAnchor="end" height={70} />
                                <YAxis tick={chartTick} />
                                <Tooltip {...chartTooltip} />
                                <Bar dataKey="commits" fill="#B45309" radius={[4, 4, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </ChartCard>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}

          {/* Navigation */}
          <div className="flex gap-3 pt-2">
            <button onClick={previousStep} className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-xl border border-gray-200 hover:bg-gray-50 transition-all">
              Back
            </button>
            <motion.button
              onClick={handleProceed}
              className="flex-1 text-sm font-semibold bg-teal-500 text-white rounded-xl px-6 py-2.5
                         hover:bg-teal-600 active:scale-[0.98] transition-all"
              whileTap={{ scale: 0.98 }}
            >
              Proceed to Assignment
            </motion.button>
          </div>
        </div>
      )}

      {/* Navigation when no devs selected yet */}
      {allDisplayDevs.length === 0 && (
        <div className="flex gap-3 pt-2">
          <button onClick={previousStep} className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-xl border border-gray-200 hover:bg-gray-50 transition-all">
            Back
          </button>
          <motion.button
            onClick={handleProceed}
            className="flex-1 text-sm font-semibold bg-teal-500 text-white rounded-xl px-6 py-2.5
                       hover:bg-teal-600 active:scale-[0.98] transition-all opacity-50"
            whileTap={{ scale: 0.98 }}
          >
            Proceed to Assignment
          </motion.button>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
      <div className="text-xs font-mono uppercase tracking-wider text-gray-400 mb-3">{title}</div>
      {children}
    </div>
  );
}
