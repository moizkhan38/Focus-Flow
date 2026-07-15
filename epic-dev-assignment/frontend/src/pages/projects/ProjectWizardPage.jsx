import { useState, useEffect } from 'react';
import { apiFetch } from '../../lib/api.js';
import { useNavigate } from 'react-router-dom';
import { WorkflowProvider, useWorkflow } from '../../context/WorkflowContext';
import { AnimatePresence, motion } from 'framer-motion';
import { useProjects } from '../../hooks/useProjects';
import { useDevelopers } from '../../hooks/useDevelopers';
import { Clock, Calendar, Upload, Loader2, CheckCircle2, AlertCircle, Pencil, Zap, Hash, Users, Mail } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';

import ProgressStepper from '../../components/shared/ProgressStepper';
import Step1_EpicGeneration from '../../components/steps/Step1_EpicGeneration';
import Step2_EpicApproval from '../../components/steps/Step2_EpicApproval';
import Step3_DeveloperAnalysis from '../../components/steps/Step3_DeveloperAnalysis';
import Step4_Assignment from '../../components/steps/Step4_Assignment';

const pageVariants = {
  initial: { opacity: 0, y: 16, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -12, filter: 'blur(4px)', transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
};

// Transform snake_case wizard data → camelCase for useProjects
function transformEpicsForProject(generatedEpics) {
  return generatedEpics
    .filter((e) => e.approved)
    .map((epic) => ({
      id: epic.epic_id,
      title: epic.epic_title,
      description: epic.epic_description || '',
      status: 'approved',
      stories: (epic.user_stories || [])
        .filter((s) => s.approved)
        .map((s) => ({
          id: s.story_id,
          title: s.story_title,
          description: s.story_description || '',
          acceptanceCriteria: s.acceptance_criteria || '',
          storyPoints: parseInt(s.story_points) || 5,
          testCases: (s.test_cases || []).map((tc) => ({
            id: tc.test_case_id || '',
            description: tc.test_case_description || '',
            preconditions: tc.input_preconditions || '',
            testData: tc.input_test_data || '',
            userAction: tc.input_user_action || '',
            expectedResults: tc.expected_results || [],
          })),
          status: 'approved',
        })),
    }));
}

function suggestSprintCount(deadline, totalStories, totalPoints) {
  if (!deadline || !deadline.value) return 1;
  const v = parseInt(deadline.value) || 2;
  let totalDays;
  switch (deadline.unit) {
    case 'hours': totalDays = Math.max(1, Math.ceil(v / 24)); break;
    case 'days': totalDays = v; break;
    case 'months': totalDays = v * 30; break;
    case 'weeks':
    default: totalDays = v * 7; break;
  }
  const byDuration = Math.max(1, Math.round(totalDays / 14));
  const byStories = Math.max(1, Math.ceil(totalStories / 10));
  const byPoints = Math.max(1, Math.ceil(totalPoints / 35));
  const suggestions = [byDuration, byStories, byPoints].sort((a, b) => a - b);
  return Math.min(suggestions[1], 10);
}

function transformAssignmentsForProject(assignments) {
  return (assignments || []).map((a) => ({
    epic_id: a.epic?.epic_id,
    epic_title: a.epic?.epic_title,
    story_id: a.story?.story_id,
    story_title: a.story?.story_title,
    story_points: a.story?.story_points,
    assigned_developer: a.developer?.username,
    score: a.score,
    confidence: a.confidence,
  }));
}

function WizardContent() {
  const { currentStep, generatedEpics, developers, assignments, projectDescription, reset } = useWorkflow();
  const { addProject } = useProjects();
  const { addDevelopers, developers: rosterDevs, updateEmail: updateRosterEmail } = useDevelopers();
  const { notify } = useNotifications();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState('');
  const [deadlineValue, setDeadlineValue] = useState('');
  const [deadlineUnit, setDeadlineUnit] = useState('weeks');
  const [syncStatus, setSyncStatus] = useState('idle');
  const [syncProgress, setSyncProgress] = useState('');
  const [syncError, setSyncError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sprintCount, setSprintCount] = useState('');
  const [jiraEmails, setJiraEmails] = useState({});

  // Pre-populate jiraEmails from roster when developers are loaded.
  // Priority: roster.email → roster.jiraUsername → dev.email → dev.jiraUsername
  // (roster is the source of truth; the analyzed dev object may not have an email yet)
  useEffect(() => {
    if (!developers?.length) return;
    setJiraEmails(prev => {
      const updated = { ...prev };
      for (const d of developers) {
        if (updated[d.username]) continue; // user already edited this field
        const rosterDev = rosterDevs.find(r => r.username === d.username);
        const best = rosterDev?.email || rosterDev?.jiraUsername || d.email || d.jiraUsername;
        if (best) updated[d.username] = best;
      }
      return updated;
    });
  }, [developers, rosterDevs]);

  // Compute total stories and points from approved epics
  const { totalStories, totalPoints } = (() => {
    let stories = 0, points = 0;
    for (const epic of generatedEpics.filter(e => e.approved)) {
      for (const s of (epic.user_stories || []).filter(s => s.approved)) {
        stories++;
        points += parseInt(s.story_points) || 5;
      }
    }
    return { totalStories: stories, totalPoints: points };
  })();

  const deadline = deadlineValue ? { value: deadlineValue, unit: deadlineUnit } : null;

  // Compute sprint date ranges for preview
  const sprintPreviews = (() => {
    const count = parseInt(sprintCount) || 0;
    if (!count || !deadlineValue) return [];
    const v = parseInt(deadlineValue);
    let totalDays;
    switch (deadlineUnit) {
      case 'hours': totalDays = Math.max(1, Math.ceil(v / 24)); break;
      case 'days': totalDays = v; break;
      case 'months': totalDays = v * 30; break;
      case 'weeks':
      default: totalDays = v * 7; break;
    }
    const daysPerSprint = Math.max(1, Math.floor(totalDays / count));
    const previews = [];
    const start = new Date();
    for (let i = 0; i < count; i++) {
      const s = new Date(start);
      s.setDate(s.getDate() + i * daysPerSprint);
      const e = new Date(start);
      e.setDate(e.getDate() + (i + 1) * daysPerSprint - (i < count - 1 ? 1 : 0));
      previews.push({
        name: `Sprint ${i + 1}`,
        start: s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        end: e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        days: Math.round((e - s) / 86400000) + 1,
      });
    }
    return previews;
  })();

  const steps = {
    1: <Step1_EpicGeneration />,
    2: <Step2_EpicApproval />,
    3: <Step3_DeveloperAnalysis />,
    4: <Step4_Assignment />,
  };

  const deadlineEndDate = (() => {
    if (!deadlineValue || deadlineValue <= 0) return null;
    const d = new Date();
    const v = parseInt(deadlineValue);
    switch (deadlineUnit) {
      case 'hours': d.setHours(d.getHours() + v); break;
      case 'days': d.setDate(d.getDate() + v); break;
      case 'months': d.setMonth(d.getMonth() + v); break;
      case 'weeks':
      default: d.setDate(d.getDate() + v * 7); break;
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  })();

  const handleSaveAndSync = async () => {
    const name = projectName.trim() || 'Untitled Project';
    const epics = transformEpicsForProject(generatedEpics);
    const flatAssignments = transformAssignmentsForProject(assignments);

    if (epics.length < 2) {
      setSyncError('At least 2 approved epics are required to sync.');
      return;
    }

    setSyncStatus('syncing');
    setSyncError('');
    setSyncProgress('Creating Jira project...');

    const progressSteps = [
      { delay: 3000, msg: 'Setting up project board...' },
      { delay: 6000, msg: 'Creating sprint...' },
      { delay: 10000, msg: 'Creating epics & stories...' },
      { delay: 18000, msg: 'Assigning developers...' },
      { delay: 25000, msg: 'Moving issues to sprint...' },
      { delay: 35000, msg: 'Finalizing sync...' },
    ];
    const timers = progressSteps.map(({ delay, msg }) =>
      setTimeout(() => setSyncProgress(msg), delay)
    );

    try {
      const res = await apiFetch('/api/ai/sync-jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epics: epics.map((e) => ({ ...e, status: 'approved' })),
          assignments: flatAssignments,
          dependencies: [],
          deadline: deadlineValue ? { value: deadlineValue, unit: deadlineUnit } : null,
          sprintCount: parseInt(sprintCount) || 1,
          projectName: name,
          developerJiraMap: developers.reduce((map, d) => {
            // Priority: user-edited override > roster.email > roster.jiraUsername > dev.email > dev.jiraUsername
            const rosterDev = rosterDevs.find((r) => r.username === d.username);
            const jira = jiraEmails[d.username]
              || rosterDev?.email
              || rosterDev?.jiraUsername
              || d.email
              || d.jiraUsername;
            if (jira) map[d.username] = jira;
            return map;
          }, {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Sync failed');
      }

      const data = await res.json();

      const updatedEpics = epics.map((epic) => {
        const result = (data.results || []).find((r) => r.epicId === epic.id);
        if (!result) return epic;
        return {
          ...epic,
          jiraKey: result.epicKey,
          stories: epic.stories.map((s) => {
            const sr = (result.stories || []).find((rs) => rs.storyId === s.id);
            return sr ? { ...s, jiraKey: sr.storyKey } : s;
          }),
        };
      });

      // Persist developers with any edited Jira emails to the roster.
      // The wizard input is an email, so user-edited values are saved as `email`.
      if (developers.length > 0) {
        const devsWithJira = developers.map(d => {
          const rosterDev = rosterDevs.find(r => r.username === d.username);
          const editedEmail = jiraEmails[d.username];
          return {
            ...d,
            email: editedEmail || rosterDev?.email || d.email || '',
            jiraUsername: rosterDev?.jiraUsername || d.jiraUsername || '',
          };
        });
        addDevelopers(devsWithJira);
      }

      const projectId = Date.now().toString();
      addProject({
        id: projectId,
        name,
        rawText: projectDescription,
        createdAt: new Date().toISOString(),
        status: 'synced',
        epics: updatedEpics,
        assignments: flatAssignments,
        analyzedDevelopers: developers,
        deadline: deadlineValue ? { value: deadlineValue, unit: deadlineUnit } : null,
        jiraSprintId: data.sprintId,
        jiraProjectKey: data.jiraProjectKey,
        jiraBoardId: data.jiraBoardId,
        sprintCount: parseInt(sprintCount) || 1,
        sprints: data.sprints || [],
      });

      setSyncStatus('success');
      notify.success('Jira Sync Complete', `${name} synced with ${data.totalIssues || 'all'} issues`);
      reset();
      setTimeout(() => navigate(`/projects/${projectId}`), 1500);
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err.message);
      notify.error('Sync Failed', err.message);
    } finally {
      timers.forEach(clearTimeout);
      setSyncProgress('');
    }
  };

  const handleSaveOnly = () => {
    setSaving(true);
    const name = projectName.trim() || 'Untitled Project';
    const epics = transformEpicsForProject(generatedEpics);
    const flatAssignments = transformAssignmentsForProject(assignments);

    if (developers.length > 0) {
      const devsWithJira = developers.map(d => {
        const rosterDev = rosterDevs.find(r => r.username === d.username);
        const editedEmail = jiraEmails[d.username];
        return {
          ...d,
          email: editedEmail || rosterDev?.email || d.email || '',
          jiraUsername: rosterDev?.jiraUsername || d.jiraUsername || '',
        };
      });
      addDevelopers(devsWithJira);
    }

    const projectId = Date.now().toString();
    addProject({
      id: projectId,
      name,
      rawText: projectDescription,
      createdAt: new Date().toISOString(),
      status: assignments.length > 0 ? 'assigned' : 'stories-ready',
      epics,
      assignments: flatAssignments,
      analyzedDevelopers: developers,
      deadline: deadlineValue ? { value: deadlineValue, unit: deadlineUnit } : null,
    });

    notify.success('Project Saved', `${name} saved locally`);
    reset();
    navigate(`/projects/${projectId}`);
  };

  return (
    <div className="relative min-h-screen px-6 py-8">
      <div className="relative z-10 max-w-7xl mx-auto">
          <ProgressStepper />

          {/* Project Name — visible on Step 1 */}
          {currentStep === 1 && (
            <div className="mt-8 max-w-3xl mx-auto">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <label className="block text-xs font-mono uppercase tracking-wider text-gray-400 mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Enter project name..."
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-4 py-2.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                />
              </div>
            </div>
          )}

          <div className="mt-6">
            <AnimatePresence mode="wait">
              <motion.div key={currentStep} variants={pageVariants} initial="initial" animate="animate" exit="exit">
                {steps[currentStep]}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Step 5: Save & Sync */}
          {currentStep === 4 && assignments.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-10 max-w-3xl mx-auto space-y-6"
            >
              {/* Project Deadline */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4">
                  <Clock className="h-4 w-4 text-teal-500" />
                  Project Deadline
                </h3>
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={deadlineValue}
                    onChange={(e) => setDeadlineValue(e.target.value)}
                    placeholder="e.g. 2"
                    className="w-24 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-3 py-2.5 text-sm
                               focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                  />
                  <select
                    value={deadlineUnit}
                    onChange={(e) => setDeadlineUnit(e.target.value)}
                    className="rounded-xl border border-gray-200 bg-gray-50 text-gray-900 px-3 py-2.5 text-sm
                               focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                  </select>
                  {deadlineEndDate && (
                    <span className="flex items-center gap-1.5 text-sm text-gray-500">
                      <Calendar className="h-4 w-4 text-gray-400" />
                      Ends: <span className="font-medium text-gray-900">{deadlineEndDate}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Sprint Configuration */}
              {deadlineValue && (
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4">
                    <Hash className="h-4 w-4 text-teal-500" />
                    Sprint Configuration
                  </h3>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600">Number of Sprints</label>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={sprintCount}
                        onChange={(e) => setSprintCount(e.target.value)}
                        placeholder="e.g. 3"
                        className="w-20 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-3 py-2.5 text-sm
                                   focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                      />
                    </div>
                    <button
                      onClick={() => setSprintCount(String(suggestSprintCount(deadline, totalStories, totalPoints)))}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-teal-600 bg-teal-50 border border-teal-200 rounded-lg
                                 hover:bg-teal-100 transition-all"
                    >
                      <Zap className="h-3.5 w-3.5" />
                      Suggest optimal
                    </button>
                    <span className="text-xs text-gray-400">
                      {totalStories} stories · {totalPoints} pts
                    </span>
                  </div>

                  {/* Sprint preview cards */}
                  {sprintPreviews.length > 0 && (
                    <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {sprintPreviews.map((sp, i) => (
                        <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
                          <div className="font-semibold text-gray-900">{sp.name}</div>
                          <div className="text-gray-500">{sp.start} – {sp.end}</div>
                          <div className="text-gray-400">{sp.days} days</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Jira Team Mapping */}
              {developers.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-1">
                    <Users className="h-4 w-4 text-teal-500" />
                    Jira Team Mapping
                  </h3>
                  <p className="text-xs text-gray-400 mb-4">
                    Map each developer to their Jira account email so tasks can be assigned correctly. Without this, Jira assignment will fail silently.
                  </p>
                  <div className="space-y-2">
                    {developers.map((dev) => {
                      const rosterDev = rosterDevs.find(r => r.username === dev.username);
                      const rosterEmail = rosterDev?.email || '';
                      const rosterJira = rosterDev?.jiraUsername || '';
                      const currentValue = jiraEmails[dev.username] ?? rosterEmail ?? dev.email ?? rosterJira ?? dev.jiraUsername ?? '';
                      const hasJira = !!(jiraEmails[dev.username] || rosterEmail || dev.email || rosterJira || dev.jiraUsername);
                      return (
                        <div key={dev.username} className="flex items-center gap-3">
                          <img
                            src={dev.avatar_url || dev.avatar || `https://github.com/${dev.username}.png`}
                            alt={dev.username}
                            className="w-8 h-8 rounded-lg ring-1 ring-gray-200 flex-shrink-0"
                          />
                          <span className="text-sm font-medium text-gray-900 w-36 truncate flex-shrink-0">{dev.username}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <Mail className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
                            <input
                              type="text"
                              value={currentValue}
                              onChange={(e) => setJiraEmails(prev => ({ ...prev, [dev.username]: e.target.value }))}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (!v) return;
                                // Persist back to roster: looks like an email → save as email,
                                // otherwise save as jiraUsername (handles users who need a
                                // display name to disambiguate multiple accounts).
                                const rosterDev = rosterDevs.find(r => r.username === dev.username);
                                if (!rosterDev) return;
                                if (v.includes('@')) {
                                  updateRosterEmail(dev.username, v);
                                }
                              }}
                              placeholder="Jira email or display name (e.g. john@company.com)"
                              className="flex-1 rounded-lg border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-3 py-2 text-sm
                                         focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                            />
                          </div>
                          {hasJira ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-amber-400 flex-shrink-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {developers.some(d => {
                    const rosterDev = rosterDevs.find(r => r.username === d.username);
                    return !(jiraEmails[d.username] || rosterDev?.email || d.email || rosterDev?.jiraUsername || d.jiraUsername);
                  }) && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      Developers without Jira emails won't be assigned to tasks or added to the Jira project team.
                    </div>
                  )}
                </div>
              )}

              {/* Sync to Jira */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Save & Sync to Jira</h3>

                {syncStatus === 'success' ? (
                  <div className="flex items-center gap-2 text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="text-sm font-medium">Successfully synced! Redirecting...</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-500">
                      A new Jira project will be created automatically with all approved epics, stories, and assignments.
                    </p>

                    {syncError && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
                          <AlertCircle className="h-4 w-4 flex-shrink-0" />
                          {syncError}
                        </div>
                        <div>
                          <label className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-gray-400 mb-2">
                            <Pencil className="h-3 w-3" />
                            Rename Project & Retry
                          </label>
                          <input
                            type="text"
                            value={projectName}
                            onChange={(e) => { setProjectName(e.target.value); setSyncStatus('idle'); }}
                            placeholder="Enter a new project name..."
                            className="w-full rounded-xl border border-gray-200 bg-gray-50 text-gray-900 placeholder-gray-400 px-4 py-2.5 text-sm
                                       focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleSaveAndSync}
                        disabled={syncStatus === 'syncing'}
                        className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold
                                   bg-teal-500 text-white rounded-xl
                                   hover:bg-teal-600 active:scale-[0.98] transition-all
                                   disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {syncStatus === 'syncing' ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {syncProgress || 'Creating Jira project & syncing...'}
                          </>
                        ) : (
                          <>
                            <Upload className="h-4 w-4" />
                            Save & Sync to Jira
                          </>
                        )}
                      </button>

                      <button
                        onClick={handleSaveOnly}
                        disabled={syncStatus === 'syncing' || saving}
                        className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-xl
                                   border border-gray-200 hover:bg-gray-50 hover:text-gray-900
                                   active:scale-[0.98] transition-all"
                      >
                        {saving ? 'Saving...' : 'Save Without Jira'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
      </div>
    </div>
  );
}

export default function ProjectWizardPage() {
  return (
    <WorkflowProvider>
      <WizardContent />
    </WorkflowProvider>
  );
}
