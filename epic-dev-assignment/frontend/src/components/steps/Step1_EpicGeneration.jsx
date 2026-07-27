import { useRef, useState } from 'react';
import { apiFetch } from '../../lib/api.js';
import { UpgradeBanner } from '../shared/UpgradePrompt';
import { useWorkflow } from '../../context/WorkflowContext';
import { motion } from 'framer-motion';
import { Zap, ChevronRight, Loader2 } from 'lucide-react';
import {
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  validateDescription,
  estimateEpicCount,
  getQualityHint,
} from '../../utils/descriptionValidator';

const exampleProjects = [
  "Build a fitness tracking mobile application with workout logging, nutrition tracking, and progress analytics",
  "Create a project management system with task tracking, team collaboration, and reporting features",
  "Develop an e-commerce platform with product catalog, shopping cart, payment integration, and order management",
  "Build a social media dashboard with post scheduling, analytics, and multi-platform integration",
  "Create a healthcare patient management system with appointments, medical records, and billing"
];

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } }
};
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } }
};

export default function Step1_EpicGeneration() {
  const {
    projectName,
    setProjectName,
    projectDescription,
    setProjectDescription,
    setGeneratedEpics,
    nextStep
  } = useWorkflow();

  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [error, setError] = useState(null);
  const [upgrade, setUpgrade] = useState(null);
  const [nameError, setNameError] = useState(null);
  const textareaRef = useRef(null);
  const nameRef = useRef(null);

  const hasName = (projectName || '').trim().length > 0;

  const descriptionLength = projectDescription.length;
  const validation = validateDescription(projectDescription);
  const qualityHint = getQualityHint(projectDescription);
  const estimatedEpics = estimateEpicCount(projectDescription);
  const counterPct = descriptionLength / MAX_DESCRIPTION_LENGTH;
  const counterColor =
    counterPct >= 1 ? 'text-red-600'
    : counterPct >= 0.9 ? 'text-amber-600'
    : 'text-gray-400';
  const hintDotColor =
    qualityHint.tone === 'success' ? 'bg-teal-500'
    : qualityHint.tone === 'warn' ? 'bg-amber-500'
    : 'bg-gray-400';

  const handleGenerate = async () => {
    // Name first: generation is a slow, paid AI call, and a project that reaches
    // Jira without a name is worse to untangle than one that never generated.
    if (!hasName) {
      setNameError('Give the project a name before generating epics.');
      nameRef.current?.focus();
      return;
    }
    setNameError(null);

    const v = validateDescription(projectDescription);
    if (!v.ok) {
      setError(v.error);
      textareaRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);
    setUpgrade(null);
    setLoadingProgress('Sending to AI...');

    const progressSteps = [
      { delay: 3000, msg: 'AI is analyzing your description...' },
      { delay: 8000, msg: 'Generating epics & user stories...' },
      { delay: 15000, msg: 'Creating acceptance criteria & test cases...' },
      { delay: 25000, msg: 'Finalizing documentation...' },
      { delay: 40000, msg: 'Almost there, AI is polishing output...' },
    ];
    const timers = progressSteps.map(({ delay, msg }) =>
      setTimeout(() => setLoadingProgress(msg), delay)
    );

    try {
      const response = await apiFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: projectDescription })
      });

      const text = await response.text();
      if (!text) throw new Error('Empty response from server. The AI generation may have timed out — please try again.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid response from server. Please try again.'); }

      // 402 = the org's monthly AI allowance is spent. Not an error to apologise
      // for — route them to the plans page instead of a red box they can't act on.
      if (response.status === 402) {
        setUpgrade({ message: data.message, feature: data.feature });
        return;
      }

      if (!data.success) {
        throw new Error(data.error || 'Failed to generate epics');
      }

      setGeneratedEpics(data.result.epics, data.generator_used);
      nextStep();
    } catch (err) {
      setError(err.message);
    } finally {
      timers.forEach(clearTimeout);
      setLoading(false);
      setLoadingProgress('');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Hero */}
      <div className="text-center mb-2">
        <h2 className="text-2xl font-bold text-gray-900">Generate Epic Documentation</h2>
        <p className="text-gray-500 text-sm mt-2 max-w-lg mx-auto">
          Describe your project and AI will generate comprehensive epics, user stories, acceptance criteria, and test cases.
        </p>
      </div>

      {/* Main card */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
        {/* Guide */}
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-teal-600 flex items-center gap-2 hover:text-teal-700 transition-colors">
            <ChevronRight className="w-4 h-4 group-open:rotate-90 transition-transform duration-200" />
            How to write an effective project description
          </summary>
          <div className="mt-4 space-y-4 text-sm text-gray-600">
            <div>
              <span className="text-gray-900 font-medium">1. Project Overview</span>
              <p className="mt-1 ml-4">Start with 1-3 sentences describing your application's purpose.</p>
              <code className="block ml-4 mt-1.5 text-xs font-mono p-2.5 rounded-lg text-teal-700 bg-teal-50 border border-teal-100">
                "Create a modern fitness tracking web app that helps users monitor their daily health..."
              </code>
            </div>
            <div>
              <span className="text-gray-900 font-medium">2. Core Features</span>
              <p className="mt-1 ml-4">List main features as numbered items. Each feature = 1 epic.</p>
              <code className="block ml-4 mt-1.5 text-xs font-mono p-2.5 rounded-lg text-teal-700 bg-teal-50 border border-teal-100 whitespace-pre">{`1. User Authentication - accounts, login, OAuth
2. Dashboard - overview, analytics, stats
3. Workout Logging - exercises, sets, history`}</code>
            </div>
            <div>
              <span className="text-gray-900 font-medium">3. Feature Details</span>
              <p className="mt-1 ml-4">Add bullet points under each feature for specific requirements.</p>
            </div>
            <div className="pt-3 border-t border-gray-100">
              <p className="text-teal-600 text-xs font-mono">
                TIP: More features (up to 15) = more epics generated. Each numbered feature = 1 epic.
              </p>
            </div>
          </div>
        </details>

        {/* Project name — required before generating */}
        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-gray-400 mb-2">
            Project Name <span className="text-red-500">*</span>
          </label>
          <input
            ref={nameRef}
            type="text"
            value={projectName || ''}
            onChange={(e) => {
              setProjectName(e.target.value);
              if (nameError) setNameError(null);
            }}
            placeholder="e.g. Acme Store Rebuild"
            aria-invalid={!!nameError}
            disabled={loading}
            className={`w-full rounded-xl border bg-gray-50 text-gray-900 placeholder-gray-400 px-4 py-2.5 text-sm
                       focus:outline-none focus:ring-2 transition-all
                       ${nameError
                         ? 'border-red-300 focus:ring-red-500/20 focus:border-red-500'
                         : 'border-gray-200 focus:ring-teal-500/20 focus:border-teal-500'}`}
          />
          {nameError && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              role="alert"
              className="mt-2 text-xs text-red-600"
            >
              {nameError}
            </motion.p>
          )}
        </div>

        {/* Textarea */}
        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-gray-400 mb-2">
            Project Description
          </label>
          <textarea
            ref={textareaRef}
            value={projectDescription}
            onChange={(e) => {
              setProjectDescription(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Build a modern task management application with real-time collaboration, notifications, and analytics..."
            maxLength={MAX_DESCRIPTION_LENGTH}
            aria-invalid={!!error}
            className={`w-full h-40 resize-none rounded-xl border bg-gray-50 text-gray-900 placeholder-gray-400 px-4 py-3 text-sm
                       focus:outline-none focus:ring-2 transition-all
                       ${error
                         ? 'border-red-300 focus:ring-red-500/20 focus:border-red-500'
                         : 'border-gray-200 focus:ring-teal-500/20 focus:border-teal-500'}`}
            disabled={loading}
          />
          <div className="mt-2 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-gray-500">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${hintDotColor}`} aria-hidden="true" />
              <span>{qualityHint.message}</span>
            </div>
            <span className={`font-mono ${counterColor}`}>
              {descriptionLength} / {MAX_DESCRIPTION_LENGTH}
            </span>
          </div>
          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              role="alert"
              className="mt-2 text-xs text-red-600"
            >
              {error}
            </motion.p>
          )}
          {upgrade && (
            <div className="mt-3">
              <UpgradeBanner message={upgrade.message} feature={upgrade.feature} />
            </div>
          )}
        </div>

        {/* Examples */}
        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-gray-400 mb-3">
            Quick Start Templates
          </label>
          <motion.div
            className="grid gap-2"
            variants={containerVariants}
            initial="hidden"
            animate="show"
          >
            {exampleProjects.map((example, index) => (
              <motion.button
                key={index}
                variants={itemVariants}
                onClick={() => setProjectDescription(example)}
                className="w-full text-left px-4 py-3 rounded-xl text-sm text-gray-600
                         bg-gray-50 border border-gray-200
                         hover:bg-gray-100 hover:border-gray-300 hover:text-gray-900
                         transition-all duration-200"
                disabled={loading}
                whileHover={{ x: 4 }}
                whileTap={{ scale: 0.99 }}
              >
                {example}
              </motion.button>
            ))}
          </motion.div>
        </div>

        {/* Generate button */}
        <motion.button
          onClick={handleGenerate}
          disabled={loading || !validation.ok || !hasName}
          className="w-full flex items-center justify-center gap-2 text-sm font-semibold
                     bg-teal-500 text-white rounded-xl px-6 py-3
                     hover:bg-teal-600 active:scale-[0.98] transition-all
                     disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-teal-500"
          whileTap={{ scale: 0.98 }}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{loadingProgress || 'Generating epics...'}</span>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Generate Epics
              {validation.ok && (
                <span className="text-xs font-normal opacity-80">
                  · ~{estimatedEpics} epic{estimatedEpics === 1 ? '' : 's'}
                </span>
              )}
            </span>
          )}
        </motion.button>

        <p className="text-center text-xs text-gray-400">
          Generates 3-15 epics based on features described. Each epic includes user stories, acceptance criteria, and test cases.
        </p>
      </div>
    </div>
  );
}
