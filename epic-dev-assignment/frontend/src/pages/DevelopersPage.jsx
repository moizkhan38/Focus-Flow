import { useState, useMemo } from 'react';
import { apiFetch, humanizeError } from '../lib/api.js';
import { useDevelopers } from '../hooks/useDevelopers';
import { useProjects } from '../hooks/useProjects';
import { useIntegrations } from '../hooks/useIntegrations';
import NotConnected from '../components/shared/NotConnected';
import {
  Users, Search, Trash2, Save, ChevronDown, ChevronRight,
  Briefcase, GitBranch, Award, AlertCircle, Plus, X, Loader2, UserPlus,
  Circle, Clock, Palmtree, RefreshCw, Mail,
} from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';

export default function DevelopersPage() {
  const { developers, addDevelopers, updateJiraUsername, updateEmail, updateAvailability, removeDeveloper, isLoaded } = useDevelopers();
  const { projects } = useProjects();
  const { notify } = useNotifications();
  const { github, isLoading: integrationsLoading } = useIntegrations();
  // Analysis + the refresh job both read GitHub through the org's own token.
  const githubBlocked = !integrationsLoading && !github?.connected;
  const [search, setSearch] = useState('');
  const [editingJira, setEditingJira] = useState({});
  const [editingEmail, setEditingEmail] = useState({});
  const [expandedDev, setExpandedDev] = useState(null);
  const [saveStatus, setSaveStatus] = useState({});
  const [emailSaveStatus, setEmailSaveStatus] = useState({});

  // Add developer form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newDevInputs, setNewDevInputs] = useState([{ github: '', email: '', jira: '' }]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState('');
  const [analyzeError, setAnalyzeError] = useState('');

  // Refresh-from-GitHub state
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await apiFetch('/api/db/developers/refresh', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Refresh failed');
      const data = await res.json();
      // Map DB rows back into the localStorage roster shape and merge in.
      const refreshed = (data.developers || []).map(d => ({
        username: d.username,
        email: d.email || '',
        jiraUsername: d.jira_username || '',
        avatar_url: d.avatar_url,
        primary_expertise: d.primary_expertise,
        experience_level: d.experience_level,
        top_skills: d.top_skills || [],
        analysis: d.analysis,
        availability: d.availability,
      }));
      if (refreshed.length > 0) addDevelopers(refreshed);
      notify.success(
        'Developers Refreshed',
        `${data.updated}/${data.total} updated from GitHub${data.failed ? ` (${data.failed} failed)` : ''}`
      );
    } catch (err) {
      notify.error('Refresh Failed', humanizeError(err));
    } finally {
      setRefreshing(false);
    }
  };

  // Build assignment data per developer across all projects
  const devAssignments = useMemo(() => {
    const map = {};
    for (const project of projects) {
      if (!project.assignments) continue;
      for (const a of project.assignments) {
        const username = a.assigned_developer;
        if (!username) continue;
        if (!map[username]) map[username] = [];
        map[username].push({
          projectId: project.id,
          projectName: project.name,
          projectStatus: project.status,
          epicId: a.epic_id,
          epicTitle: a.epic_title,
          jiraProjectKey: project.jiraProjectKey || null,
        });
      }
    }
    return map;
  }, [projects]);

  const filtered = useMemo(() => {
    if (!search.trim()) return developers;
    const q = search.toLowerCase();
    return developers.filter(
      (d) =>
        d.username.toLowerCase().includes(q) ||
        (d.email || '').toLowerCase().includes(q) ||
        (d.jiraUsername || '').toLowerCase().includes(q) ||
        (d.primary_expertise || '').toLowerCase().includes(q)
    );
  }, [developers, search]);

  const handleJiraChange = (username, value) => {
    setEditingJira((prev) => ({ ...prev, [username]: value }));
  };

  const handleJiraSave = (username) => {
    const value = editingJira[username];
    if (value !== undefined) {
      updateJiraUsername(username, value);
      setSaveStatus((prev) => ({ ...prev, [username]: true }));
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [username]: false })), 2000);
    }
    setEditingJira((prev) => {
      const copy = { ...prev };
      delete copy[username];
      return copy;
    });
  };

  const handleEmailChange = (username, value) => {
    setEditingEmail((prev) => ({ ...prev, [username]: value }));
  };

  const handleEmailSave = (username) => {
    const value = editingEmail[username];
    if (value !== undefined) {
      updateEmail(username, value.trim());
      setEmailSaveStatus((prev) => ({ ...prev, [username]: true }));
      setTimeout(() => setEmailSaveStatus((prev) => ({ ...prev, [username]: false })), 2000);
    }
    setEditingEmail((prev) => {
      const copy = { ...prev };
      delete copy[username];
      return copy;
    });
  };

  const addInput = () => {
    setNewDevInputs([...newDevInputs, { github: '', email: '', jira: '' }]);
  };

  const removeInput = (i) => {
    setNewDevInputs(newDevInputs.filter((_, idx) => idx !== i));
  };

  const updateInput = (i, field, value) => {
    const updated = [...newDevInputs];
    updated[i][field] = value;
    setNewDevInputs(updated);
  };

  const handleAnalyzeAndAdd = async () => {
    const valid = newDevInputs.filter((d) => d.github.trim());
    if (valid.length === 0) {
      setAnalyzeError('Enter at least one GitHub username.');
      return;
    }

    setAnalyzing(true);
    setAnalyzeError('');
    setAnalyzeProgress('Connecting to GitHub...');

    const progressSteps = [
      { delay: 3000, msg: 'Fetching repositories...' },
      { delay: 8000, msg: 'Analyzing commit history...' },
      { delay: 15000, msg: 'Detecting expertise from file patterns...' },
      { delay: 25000, msg: 'Calculating experience levels...' },
      { delay: 40000, msg: 'Processing detailed commit data...' },
      { delay: 60000, msg: 'Almost done, finalizing analysis...' },
    ];
    const timers = progressSteps.map(({ delay, msg }) =>
      setTimeout(() => setAnalyzeProgress(msg), delay)
    );

    try {
      const response = await apiFetch('/api/analyze-developers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          developers: valid.map((d) => ({ username: d.github.trim() })),
        }),
      });

      const text = await response.text();
      if (!text) throw new Error('Empty response from server.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid response from server.'); }
      if (!data.success) throw new Error(data.error || 'Analysis failed');

      if (data.developers.length === 0) {
        throw new Error('No developers could be analyzed. Check usernames and try again.');
      }

      // Merge Jira emails + handles from the form
      const emailMap = {};
      const jiraMap = {};
      for (const d of valid) {
        if (d.email?.trim()) emailMap[d.github.trim()] = d.email.trim();
        if (d.jira?.trim()) jiraMap[d.github.trim()] = d.jira.trim();
      }

      const enriched = data.developers.map((dev) => ({
        ...dev,
        email: emailMap[dev.username] || '',
        jiraUsername: jiraMap[dev.username] || '',
      }));

      addDevelopers(enriched);
      notify.success('Developers Added', `${enriched.length} developer${enriched.length > 1 ? 's' : ''} analyzed and added to roster`);

      // Reset form
      setNewDevInputs([{ github: '', email: '', jira: '' }]);
      setShowAddForm(false);
      setAnalyzeProgress('');
    } catch (err) {
      setAnalyzeError(humanizeError(err));
      notify.error('Analysis Failed', err.message);
    } finally {
      timers.forEach(clearTimeout);
      setAnalyzing(false);
      setAnalyzeProgress('');
    }
  };

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Users className="h-6 w-6 text-blue-600" />
            Developers
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {developers.length} developer{developers.length !== 1 ? 's' : ''} in roster
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefreshAll}
            disabled={refreshing || developers.length === 0}
            title="Re-fetch every developer's GitHub stats (also runs daily at 03:00)"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-blue-600' : 'text-gray-500'}`} />
            {refreshing ? 'Refreshing...' : 'Refresh from GitHub'}
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Add Developer
          </button>
        </div>
      </div>

      {/* Add Developer Form */}
      {showAddForm && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50/50 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-1">Analyze & Add Developers</h3>
          <p className="text-xs text-gray-500 mb-4">
            Enter GitHub usernames to analyze commits & expertise. Add a Jira email so they can be invited to Jira and assigned issues automatically.
          </p>

          {githubBlocked && (
            <div className="mb-4">
              <NotConnected provider="github" compact />
            </div>
          )}

          <div className="space-y-2">
            {newDevInputs.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={d.github}
                  onChange={(e) => updateInput(i, 'github', e.target.value)}
                  placeholder="GitHub Username *"
                  disabled={analyzing}
                  className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
                <input
                  type="email"
                  value={d.email}
                  onChange={(e) => updateInput(i, 'email', e.target.value)}
                  placeholder="Jira Email (e.g. john@company.com)"
                  disabled={analyzing}
                  className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
                <input
                  type="text"
                  value={d.jira}
                  onChange={(e) => updateInput(i, 'jira', e.target.value)}
                  placeholder="Jira Display Name (optional)"
                  disabled={analyzing}
                  className="w-44 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
                {newDevInputs.length > 1 && (
                  <button
                    onClick={() => removeInput(i)}
                    disabled={analyzing}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={addInput}
              disabled={analyzing || newDevInputs.length >= 10}
              className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> Add Another
            </button>
            <div className="flex-1" />
            <button
              onClick={() => { setShowAddForm(false); setAnalyzeError(''); }}
              disabled={analyzing}
              className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAnalyzeAndAdd}
              disabled={analyzing || !newDevInputs.some((d) => d.github.trim())}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {analyzeProgress || 'Analyzing...'}
                </>
              ) : (
                <>
                  <GitBranch className="h-4 w-4" />
                  Analyze & Add
                </>
              )}
            </button>
          </div>

          {analyzeError && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {analyzeError}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      {developers.length > 0 && (
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by username, email, Jira handle, or expertise..."
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {developers.length === 0 && !showAddForm ? (
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
          <Users className="mx-auto h-12 w-12 text-gray-300" />
          <h3 className="mt-4 text-lg font-semibold text-gray-700">No developers yet</h3>
          <p className="mt-2 text-sm text-gray-500">
            Click "Add Developer" to analyze GitHub profiles and build your team roster.
          </p>
          <button
            onClick={() => setShowAddForm(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Add Your First Developer
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((dev) => {
            const assignments = devAssignments[dev.username] || [];
            const isExpanded = expandedDev === dev.username;
            const jiraValue = editingJira[dev.username] ?? dev.jiraUsername ?? '';
            const emailValue = editingEmail[dev.username] ?? dev.email ?? '';
            const hasEmail = !!dev.email;

            return (
              <div
                key={dev.username}
                className="overflow-hidden rounded-xl border border-gray-200 bg-white"
              >
                {/* Developer Header */}
                <div className="px-5 py-4">
                  <div className="flex items-start gap-4">
                    <img
                      src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                      alt={dev.username}
                      className="h-12 w-12 rounded-full ring-2 ring-gray-100"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-gray-900">{dev.username}</h3>
                        {dev.experience_level && (
                          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                            {dev.experience_level}
                          </span>
                        )}
                        {dev.primary_expertise && (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                            {dev.primary_expertise}
                          </span>
                        )}
                        {!hasEmail && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600 flex items-center gap-1">
                            <AlertCircle className="h-3 w-3" />
                            No Jira email
                          </span>
                        )}
                      </div>

                      {/* Jira Email Input — used for invites & assignment */}
                      <div className="mt-2 flex items-center gap-2">
                        <label className="text-xs font-medium text-gray-400 whitespace-nowrap flex items-center gap-1">
                          <Mail className="h-3 w-3" /> Jira Email:
                        </label>
                        <input
                          type="email"
                          value={emailValue}
                          onChange={(e) => handleEmailChange(dev.username, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleEmailSave(dev.username)}
                          placeholder="e.g. john@company.com"
                          className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-sm text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 w-72"
                        />
                        {editingEmail[dev.username] !== undefined && (
                          <button
                            onClick={() => handleEmailSave(dev.username)}
                            className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 transition-colors"
                          >
                            <Save className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {emailSaveStatus[dev.username] && (
                          <span className="text-xs text-green-600 font-medium">Saved!</span>
                        )}
                      </div>

                      {/* Jira Display Name (optional fallback) */}
                      <div className="mt-2 flex items-center gap-2">
                        <label className="text-xs font-medium text-gray-400 whitespace-nowrap">Jira Display Name:</label>
                        <input
                          type="text"
                          value={jiraValue}
                          onChange={(e) => handleJiraChange(dev.username, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleJiraSave(dev.username)}
                          placeholder="optional — used as fallback search"
                          className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-sm text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 w-72"
                        />
                        {editingJira[dev.username] !== undefined && (
                          <button
                            onClick={() => handleJiraSave(dev.username)}
                            className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 transition-colors"
                          >
                            <Save className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {saveStatus[dev.username] && (
                          <span className="text-xs text-green-600 font-medium">Saved!</span>
                        )}
                      </div>

                      {/* Availability */}
                      <div className="mt-2 flex items-center gap-3">
                        <label className="text-xs font-medium text-gray-400 whitespace-nowrap">Availability:</label>
                        <div className="flex items-center gap-1">
                          {[
                            { value: 'available', label: 'Available', icon: Circle, color: 'text-emerald-500 bg-emerald-50 border-emerald-200' },
                            { value: 'busy', label: 'Busy', icon: Clock, color: 'text-amber-500 bg-amber-50 border-amber-200' },
                            { value: 'on-leave', label: 'On Leave', icon: Palmtree, color: 'text-red-500 bg-red-50 border-red-200' },
                          ].map((opt) => {
                            const isActive = (dev.availability?.status || 'available') === opt.value;
                            return (
                              <button
                                key={opt.value}
                                onClick={() => updateAvailability(dev.username, { status: opt.value })}
                                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-all ${
                                  isActive ? opt.color : 'text-gray-400 bg-white border-gray-200 hover:bg-gray-50'
                                }`}
                              >
                                <opt.icon className="h-3 w-3" />
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-1.5 ml-2">
                          <label className="text-xs font-medium text-gray-400">Capacity:</label>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="10"
                            value={dev.availability?.capacity ?? 100}
                            onChange={(e) => updateAvailability(dev.username, { capacity: parseInt(e.target.value) })}
                            className="w-20 h-1.5 accent-blue-600"
                          />
                          <span className="text-[11px] font-medium text-gray-600 w-8">{dev.availability?.capacity ?? 100}%</span>
                        </div>
                      </div>

                      {/* Stats Row */}
                      <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                        {dev.analysis?.totalCommits && (
                          <span className="flex items-center gap-1">
                            <GitBranch className="h-3 w-3" />
                            {dev.analysis.totalCommits} commits
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Briefcase className="h-3 w-3" />
                          {assignments.length} assignment{assignments.length !== 1 ? 's' : ''}
                        </span>
                        {dev.top_skills?.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Award className="h-3 w-3" />
                            {dev.top_skills.slice(0, 3).join(', ')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedDev(isExpanded ? null : dev.username)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 transition-colors flex items-center gap-1"
                      >
                        {isExpanded ? 'Hide' : 'Work'}
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Remove ${dev.username} from the roster?`)) {
                            removeDeveloper(dev.username);
                          }
                        }}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded: Assigned Work */}
                {isExpanded && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
                    <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                      Assigned Work
                    </h4>
                    {assignments.length === 0 ? (
                      <p className="text-sm text-gray-400">No assignments yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {assignments.map((a, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between rounded-lg bg-white border border-gray-100 px-4 py-2.5"
                          >
                            <div>
                              <span className="text-sm font-medium text-gray-800">{a.epicTitle}</span>
                              <span className="ml-2 text-xs text-gray-400">in {a.projectName}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {a.jiraProjectKey && (
                                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                                  {a.jiraProjectKey}
                                </span>
                              )}
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                  a.projectStatus === 'synced'
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {a.projectStatus === 'synced' ? 'Synced' : 'Pending'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
