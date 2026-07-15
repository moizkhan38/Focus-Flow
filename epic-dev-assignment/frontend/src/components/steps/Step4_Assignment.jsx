import { useState, useMemo } from 'react';
import { apiFetch } from '../../lib/api.js';
import { useWorkflow } from '../../context/WorkflowContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, RefreshCw, Search, ChevronDown, ChevronRight, AlertTriangle, Loader2, FileJson, FileSpreadsheet } from 'lucide-react';

const EPIC_ICONS = {
  'Mobile Development': '📱', 'Frontend Development': '🌐', 'Backend Development': '⚙️',
  'DevOps/Infrastructure': '🚀', 'Data Science/ML': '📊', 'Database/SQL': '💾'
};

const confidenceStyle = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  'manual-verified': 'bg-teal-100 text-teal-700',
  manual: 'bg-amber-100 text-amber-700',
  low: 'bg-red-100 text-red-700',
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: (i) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.35, ease: [0.16, 1, 0.3, 1] }
  })
};

const inputCls = "rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all";
const btnSubtle = "text-xs py-1.5 px-3 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all";
const badge = "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono";

export default function Step4_Assignment() {
  const {
    approvedEpics, developers, assignments, workloadDistribution,
    setAssignments, reassignEpic, previousStep
  } = useWorkflow();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedEpics, setExpandedEpics] = useState({});

  // Group story-level assignments by epic
  const epicGroups = useMemo(() => {
    const groups = {};
    for (const a of assignments) {
      const epicId = a.epic?.epic_id || a.story?.story_id || 'unknown';
      if (!groups[epicId]) {
        groups[epicId] = {
          epic_id: a.epic?.epic_id,
          epic_title: a.epic?.epic_title,
          classification: a.epic?.classification,
          stories: [],
          totalPoints: 0,
          developers: new Set(),
        };
      }
      groups[epicId].stories.push(a);
      groups[epicId].totalPoints += a.story?.story_points || a.epic?.totalStoryPoints || 0;
      groups[epicId].developers.add(a.developer?.username);
    }
    return Object.values(groups);
  }, [assignments]);

  const isStoryLevel = assignments.length > 0 && assignments[0]?.story?.story_id;

  const handleAutoAssign = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/auto-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epics: approvedEpics, developers })
      });
      const text = await response.text();
      if (!text) throw new Error('Empty response from server. Please try again.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid response from server. Please try again.'); }
      if (!data.success) throw new Error(data.error || 'Failed to auto-assign');
      setAssignments(data.assignments, data.workloadDistribution);
      // Auto-expand all epics
      const expanded = {};
      for (const a of data.assignments) {
        if (a.epic?.epic_id) expanded[a.epic.epic_id] = true;
      }
      setExpandedEpics(expanded);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReassign = (epicOrStoryId, newDeveloperUsername) => {
    reassignEpic(epicOrStoryId, newDeveloperUsername);
  };

  const toggleEpic = (epicId) => {
    setExpandedEpics(prev => ({ ...prev, [epicId]: !prev[epicId] }));
  };

  const exportToCSV = () => {
    const headers = ['Epic ID', 'Epic Title', 'Epic Type', 'Story ID', 'Story Title', 'Story Points', 'Developer', 'Expertise', 'Experience', 'Score', 'Confidence'];
    const rows = assignments.map(a => [
      a.epic?.epic_id, `"${a.epic?.epic_title || ''}"`, a.epic?.classification?.primary || 'N/A',
      a.story?.story_id || '', `"${a.story?.story_title || ''}"`, a.story?.story_points || '',
      a.developer?.username, a.developer?.expertise, a.developer?.experienceLevel, a.score, a.confidence
    ]);
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `story-assignments-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const exportToJSON = () => {
    const data = {
      exportDate: new Date().toISOString(),
      totalStories: assignments.length,
      totalDevelopers: developers.length,
      totalStoryPoints: epicGroups.reduce((sum, g) => sum + g.totalPoints, 0),
      workloadDistribution,
      assignments: assignments.map(a => ({
        epic: { id: a.epic?.epic_id, title: a.epic?.epic_title, type: a.epic?.classification?.primary },
        story: a.story || null,
        developer: { username: a.developer?.username, expertise: a.developer?.expertise, experienceLevel: a.developer?.experienceLevel, score: a.score },
        confidence: a.confidence, alternatives: a.alternatives
      }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `story-assignments-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const filteredEpicGroups = searchTerm
    ? epicGroups.filter(g => {
        const term = searchTerm.toLowerCase();
        return g.epic_title?.toLowerCase().includes(term)
          || g.epic_id?.toLowerCase().includes(term)
          || g.stories.some(s => s.developer?.username?.toLowerCase().includes(term)
            || s.story?.story_title?.toLowerCase().includes(term));
      })
    : epicGroups;

  const stats = {
    totalStories: assignments.length,
    totalPoints: epicGroups.reduce((sum, g) => sum + g.totalPoints, 0),
    highConfidence: assignments.filter(a => a.confidence === 'high').length,
    mediumConfidence: assignments.filter(a => a.confidence === 'medium').length,
    lowConfidence: assignments.filter(a => a.confidence === 'low').length,
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-xl font-bold text-gray-900">Story Assignment Dashboard</h2>
        <p className="text-gray-500 text-sm mt-1 mb-6">
          Auto-assign stories to developers based on expertise matching and workload balancing
        </p>

        {assignments.length === 0 ? (
          <div>
            <motion.button
              onClick={handleAutoAssign}
              disabled={loading}
              className="w-full text-sm font-semibold bg-teal-500 text-white rounded-xl px-6 py-3
                         hover:bg-teal-600 active:scale-[0.98] transition-all
                         disabled:opacity-40 disabled:cursor-not-allowed"
              whileTap={{ scale: 0.98 }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Calculating story assignments...
                </span>
              ) : 'Auto-Assign Stories'}
            </motion.button>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200"
              >
                <p className="text-red-600 text-sm">{error}</p>
              </motion.div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {[
                { label: 'Epics', value: epicGroups.length, color: 'text-teal-600' },
                { label: 'Stories', value: stats.totalStories, color: 'text-purple-600' },
                { label: 'Points', value: stats.totalPoints, color: 'text-indigo-600' },
                { label: 'High', value: stats.highConfidence, color: 'text-emerald-600' },
                { label: 'Medium', value: stats.mediumConfidence, color: 'text-amber-600' },
                { label: 'Low', value: stats.lowConfidence, color: 'text-red-600' },
              ].map((s, i) => (
                <motion.div
                  key={i}
                  className="bg-gray-50 rounded-xl border border-gray-200 p-3"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                >
                  <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-0.5">{s.label}</div>
                  <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                </motion.div>
              ))}
            </div>

            {/* Controls */}
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search epics, stories, or developers..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className={inputCls + " w-full pl-9"}
                />
              </div>
              <div className="flex gap-1.5">
                <button onClick={exportToCSV} className={btnSubtle + " flex items-center gap-1"}>
                  <FileSpreadsheet className="w-3 h-3" />CSV
                </button>
                <button onClick={exportToJSON} className={btnSubtle + " flex items-center gap-1"}>
                  <FileJson className="w-3 h-3" />JSON
                </button>
                <button onClick={handleAutoAssign} className={btnSubtle + " text-teal-600 flex items-center gap-1"}>
                  <RefreshCw className="w-3 h-3" />Re-assign
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Workload Distribution */}
      {assignments.length > 0 && workloadDistribution && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400 mb-4">Workload Distribution</h3>
          <div className="space-y-3">
            {Object.entries(workloadDistribution).map(([username, points], i) => {
              const maxPoints = Math.max(...Object.values(workloadDistribution));
              const percentage = maxPoints > 0 ? (points / maxPoints) * 100 : 0;
              const dev = developers.find(d => d.username === username);

              return (
                <motion.div
                  key={username}
                  className="flex items-center gap-3"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.06, duration: 0.35 }}
                >
                  <div className="flex items-center gap-2 w-40">
                    {dev?.avatar && <img src={dev.avatar} alt={username} className="w-7 h-7 rounded-lg ring-1 ring-gray-200" />}
                    <span className="text-sm text-gray-600 truncate">{username}</span>
                  </div>
                  <div className="flex-1 h-8 bg-gray-50 rounded-lg overflow-hidden relative border border-gray-200">
                    <motion.div
                      className="h-full bg-gradient-to-r from-teal-200 to-teal-100 flex items-center justify-end px-3"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(percentage, 15)}%` }}
                      transition={{ duration: 0.6, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <span className="text-xs font-mono text-gray-900">{points} pts</span>
                    </motion.div>
                  </div>
                  <span className="w-12 text-right text-xs font-mono text-gray-400">{percentage.toFixed(0)}%</span>
                </motion.div>
              );
            })}
          </div>

          <div className="mt-4 pt-3 flex items-center gap-2 border-t border-gray-100">
            {(() => {
              const values = Object.values(workloadDistribution);
              if (values.length === 0) return null;
              const max = Math.max(...values);
              const min = Math.min(...values);
              const diff = max > 0 ? ((max - min) / max) * 100 : 0;
              const isBalanced = diff < 30;
              return (
                <>
                  <span className={`${badge} ${isBalanced ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {isBalanced ? 'Balanced' : 'Unbalanced'}
                  </span>
                  <span className="text-xs text-gray-400">{diff.toFixed(0)}% difference</span>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Epic + Story Assignments */}
      {assignments.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400">
            Story Assignments ({assignments.length} stories across {epicGroups.length} epics)
          </h3>

          {filteredEpicGroups.map((group, i) => {
            const icon = EPIC_ICONS[group.classification?.primary] || '💻';
            const isExpanded = expandedEpics[group.epic_id];
            const devNames = [...group.developers];

            return (
              <motion.div
                key={group.epic_id}
                custom={i}
                variants={cardVariants}
                initial="hidden"
                animate="show"
              >
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  {/* Epic header — clickable to expand */}
                  <button
                    onClick={() => toggleEpic(group.epic_id)}
                    className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-lg">{icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className={`${badge} bg-teal-100 text-teal-700`}>{group.epic_id}</span>
                        <span className="text-xs text-gray-400">
                          {group.classification?.primary} · {group.totalPoints} pts · {group.stories.length} stories
                        </span>
                      </div>
                      <h4 className="font-medium text-gray-900 truncate">{group.epic_title}</h4>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Dev avatars */}
                      <div className="flex -space-x-1.5">
                        {devNames.slice(0, 3).map(uname => {
                          const dev = developers.find(d => d.username === uname);
                          return dev?.avatar ? (
                            <img key={uname} src={dev.avatar} alt={uname} className="w-6 h-6 rounded-full ring-2 ring-white" title={uname} />
                          ) : (
                            <div key={uname} className="w-6 h-6 rounded-full ring-2 ring-white bg-gray-200 flex items-center justify-center text-[9px] font-bold text-gray-500" title={uname}>
                              {uname[0]?.toUpperCase()}
                            </div>
                          );
                        })}
                        {devNames.length > 3 && (
                          <div className="w-6 h-6 rounded-full ring-2 ring-white bg-gray-200 flex items-center justify-center text-[9px] font-medium text-gray-500">
                            +{devNames.length - 3}
                          </div>
                        )}
                      </div>
                      <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                        <ChevronDown className="w-4 h-4 text-gray-400" />
                      </motion.div>
                    </div>
                  </button>

                  {/* Expanded story assignments */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-gray-100 divide-y divide-gray-50">
                          {group.stories.map((a, idx) => (
                            <div key={a.story?.story_id || idx} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50/50 transition-colors">
                              {/* Story info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className={`${badge} bg-indigo-100 text-indigo-700 text-[10px]`}>
                                    {a.story?.story_id || `S${idx + 1}`}
                                  </span>
                                  <span className="text-xs text-gray-400">{a.story?.story_points || 0} SP</span>
                                </div>
                                <p className="text-sm text-gray-800 truncate">{a.story?.story_title || a.epic?.epic_title}</p>
                              </div>

                              {/* Assigned developer */}
                              <div className="flex items-center gap-2 min-w-[140px]">
                                {a.developer?.avatar && (
                                  <img src={a.developer.avatar} alt={a.developer.username} className="w-6 h-6 rounded-full ring-1 ring-gray-200" />
                                )}
                                <div className="min-w-0">
                                  <span className="text-xs font-medium text-gray-700 block truncate">{a.developer?.username}</span>
                                  <span className="text-[10px] text-gray-400">{a.developer?.expertise}</span>
                                </div>
                              </div>

                              {/* Score */}
                              <span className="text-xs font-mono text-teal-600 w-10 text-right">{a.score}</span>

                              {/* Confidence */}
                              <span className={`${badge} text-[10px] w-16 justify-center ${confidenceStyle[a.confidence] || confidenceStyle.low}`}>
                                {a.confidence}
                              </span>

                              {/* Reassign dropdown */}
                              <select
                                value={a.developer?.username || ''}
                                onChange={(e) => handleReassign(a.story?.story_id || a.epic?.epic_id, e.target.value)}
                                className="rounded-lg border border-gray-200 bg-gray-50 text-xs py-1 px-1.5 w-28 focus:outline-none focus:ring-1 focus:ring-teal-500"
                              >
                                <option value={a.developer?.username}>{a.developer?.username}</option>
                                {developers
                                  .filter(d => d.username !== a.developer?.username)
                                  .map(dev => (
                                    <option key={dev.username} value={dev.username}>{dev.username}</option>
                                  ))}
                              </select>
                            </div>
                          ))}
                        </div>

                        {/* Alternatives row */}
                        {group.stories[0]?.alternatives?.length > 0 && (
                          <div className="px-5 py-2.5 border-t border-gray-100 flex items-center gap-2 flex-wrap bg-gray-50/50">
                            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Alt devs:</span>
                            {group.stories[0].alternatives.map((alt, j) => (
                              <span key={j} className={`${badge} bg-gray-100 text-gray-500 text-[10px]`}>
                                {alt.username} ({alt.score})
                              </span>
                            ))}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}

          {filteredEpicGroups.length === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm">
              No assignments match your search
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3 items-center">
        <button onClick={previousStep} className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-xl border border-gray-200 hover:bg-gray-50 transition-all">
          Back
        </button>
        {assignments.length > 0 && (
          <div className="flex-1 text-center text-xs text-gray-400">
            Assignment complete. Export or modify as needed.
          </div>
        )}
      </div>
    </div>
  );
}
