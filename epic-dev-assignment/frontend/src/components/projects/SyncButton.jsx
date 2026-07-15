import { useState, useEffect } from 'react';
import { apiFetch } from '../../lib/api.js';
import { Upload, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Users, FolderPlus, GitBranch, UserPlus, Play, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SYNC_STEPS = [
  { key: 'project', label: 'Creating Jira project...', icon: FolderPlus, duration: 2500 },
  { key: 'invite', label: 'Inviting developers via email...', icon: Mail, duration: 3000 },
  { key: 'team', label: 'Adding developers to team...', icon: UserPlus, duration: 3000 },
  { key: 'epics', label: 'Creating epics & stories...', icon: GitBranch, duration: 5000 },
  { key: 'sprints', label: 'Setting up sprints & assigning...', icon: Users, duration: 3500 },
  { key: 'start', label: 'Starting sprint...', icon: Play, duration: 2000 },
];

export default function SyncButton({ epics, assignments, dependencies, deadline, projectName, sprintCount, developerJiraMap, onSyncComplete }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [syncWarnings, setSyncWarnings] = useState([]);
  const [invitedDevs, setInvitedDevs] = useState([]);

  const approvedEpics = (epics || []).filter((e) => e.status === 'approved');
  const canSync = approvedEpics.length >= 2;

  // Animate through progress steps while syncing
  useEffect(() => {
    if (status !== 'syncing') return;
    setCurrentStep(0);
    let step = 0;
    const timers = SYNC_STEPS.map((s, i) => {
      const delay = SYNC_STEPS.slice(0, i).reduce((sum, st) => sum + st.duration, 0);
      return setTimeout(() => { step = i; setCurrentStep(i); }, delay);
    });
    return () => timers.forEach(clearTimeout);
  }, [status]);

  const handleSync = async () => {
    if (!canSync) return;
    setStatus('syncing');
    setError('');

    try {
      const res = await apiFetch('/api/ai/sync-jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epics,
          assignments,
          dependencies: dependencies || [],
          deadline,
          projectName,
          sprintCount: sprintCount || 1,
          developerJiraMap: developerJiraMap || {},
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Sync failed');
      }

      const data = await res.json();
      setCreatedKey(data.jiraProjectKey);
      setSyncWarnings(data.warnings || []);
      setInvitedDevs(data.invitedDevelopers || []);
      setStatus('success');
      if (onSyncComplete) onSyncComplete(data.results, data.sprintId, data.jiraProjectKey, data.jiraBoardId);
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  };

  if (status === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-green-200 bg-green-50 p-4"
      >
        <div className="flex items-center gap-2 text-green-700 mb-2">
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-sm font-semibold">
            Successfully synced to Jira{createdKey ? ` (project: ${createdKey})` : ''}!
          </span>
        </div>
        <div className="space-y-1">
          {SYNC_STEPS.map((step) => (
            <div key={step.key} className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span className="text-xs">{step.label.replace('...', '')} — done</span>
            </div>
          ))}
        </div>
        {invitedDevs.length > 0 && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-blue-700 mb-1">
              <Mail className="h-3.5 w-3.5" />
              <span className="text-xs font-semibold">Developer invitations sent</span>
            </div>
            {invitedDevs.map((dev, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-blue-600 pl-5">
                <Mail className="h-3 w-3 flex-shrink-0" />
                <span>{dev}</span>
              </div>
            ))}
          </div>
        )}
        {syncWarnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-amber-700 mb-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="text-xs font-semibold">{syncWarnings.length} warning{syncWarnings.length > 1 ? 's' : ''}</span>
            </div>
            {syncWarnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-600 pl-5">• {w}</p>
            ))}
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        {canSync
          ? `${approvedEpics.length} approved epics will be synced across ${sprintCount || 1} sprint${(sprintCount || 1) > 1 ? 's' : ''}. A new Jira project will be created automatically. Developers will be added to the team.`
          : 'At least 2 approved epics are required to sync to Jira.'}
      </p>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Progress steps */}
      <AnimatePresence>
        {status === 'syncing' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden rounded-xl border border-blue-100 bg-blue-50/50 p-4"
          >
            <div className="space-y-2">
              {SYNC_STEPS.map((step, i) => {
                const StepIcon = step.icon;
                const isActive = i === currentStep;
                const isDone = i < currentStep;
                return (
                  <motion.div
                    key={step.key}
                    initial={{ opacity: 0.4 }}
                    animate={{ opacity: isDone || isActive ? 1 : 0.4 }}
                    className="flex items-center gap-2.5"
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                    ) : isActive ? (
                      <Loader2 className="h-4 w-4 text-blue-600 animate-spin flex-shrink-0" />
                    ) : (
                      <StepIcon className="h-4 w-4 text-gray-300 flex-shrink-0" />
                    )}
                    <span className={`text-xs font-medium ${isDone ? 'text-green-700' : isActive ? 'text-blue-700' : 'text-gray-400'}`}>
                      {step.label}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={handleSync}
        disabled={!canSync || status === 'syncing'}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        whileHover={canSync && status !== 'syncing' ? { scale: 1.02 } : {}}
        whileTap={canSync && status !== 'syncing' ? { scale: 0.97 } : {}}
      >
        {status === 'syncing' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Syncing to Jira...
          </>
        ) : status === 'error' ? (
          <>
            <AlertCircle className="h-4 w-4" />
            Retry Sync
          </>
        ) : (
          <>
            <Upload className="h-4 w-4" />
            Sync to Jira
          </>
        )}
      </motion.button>
    </div>
  );
}
