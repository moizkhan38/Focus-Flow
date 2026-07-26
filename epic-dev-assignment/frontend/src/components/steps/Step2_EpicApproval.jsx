import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorkflow } from '../../context/WorkflowContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, RefreshCw, ChevronDown, Loader2, Trash2, Pencil } from 'lucide-react';

function clean(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*_]{3,}\s*$/gm, '');
}

function RegenInput({ componentId, label, onSubmit, onCancel, isLoading }) {
  const [requirements, setRequirements] = useState('');

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-3 p-4 rounded-xl bg-teal-50 border border-teal-200 space-y-3 overflow-hidden"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-teal-700">
        <span>Regenerate {label}:</span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-teal-100 text-teal-700">{componentId}</span>
      </div>
      <textarea
        value={requirements}
        onChange={(e) => setRequirements(e.target.value)}
        placeholder={`Describe what you'd like changed for ${componentId}...`}
        className="w-full resize-vertical min-h-[60px] text-sm rounded-xl border border-gray-200 bg-white text-gray-900 placeholder-gray-400 px-3 py-2
                   focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all"
        disabled={isLoading}
      />
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit(requirements)}
          disabled={isLoading}
          className="text-xs py-2 px-4 rounded-lg font-semibold bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-40 transition-all"
        >
          {isLoading ? (
            <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Regenerating...</span>
          ) : 'Submit'}
        </button>
        <button onClick={onCancel} disabled={isLoading} className="text-xs py-2 px-4 rounded-lg font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-all">
          Cancel
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Inline editor for any generated item. `fields` describes what to render:
 *   { key, label, value, type: 'text' | 'textarea' | 'number' | 'list', rows }
 *
 * 'list' edits an array (test-case expected results) as one entry per line,
 * which is far easier to work with than a row of inputs.
 */
function EditPanel({ title, componentId, fields, onSave, onCancel }) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.type === 'list' ? (f.value || []).join('\n') : (f.value ?? ''),
      ])
    )
  );

  const set = (key, v) => setDraft((prev) => ({ ...prev, [key]: v }));

  const handleSave = () => {
    const patch = {};
    for (const f of fields) {
      const raw = draft[f.key];
      if (f.type === 'list') {
        patch[f.key] = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
      } else if (f.type === 'number') {
        const n = parseInt(raw, 10);
        patch[f.key] = Number.isFinite(n) ? n : f.value;
      } else {
        patch[f.key] = String(raw).trim();
      }
    }
    onSave(patch);
  };

  const inputCls =
    'w-full text-sm rounded-lg border border-gray-200 bg-white text-gray-900 placeholder-gray-400 px-3 py-2 ' +
    'focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all';

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-3 p-4 rounded-xl bg-blue-50 border border-blue-200 space-y-3 overflow-hidden"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
        <Pencil className="w-3.5 h-3.5" />
        <span>Edit {title}:</span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-blue-100 text-blue-700">
          {componentId}
        </span>
      </div>

      {fields.map((f) => (
        <div key={f.key}>
          <label className="block text-[11px] font-mono uppercase tracking-wider text-gray-500 mb-1">
            {f.label}
          </label>
          {f.type === 'textarea' || f.type === 'list' ? (
            <textarea
              value={draft[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              rows={f.rows || 3}
              placeholder={f.type === 'list' ? 'One per line' : undefined}
              className={inputCls + ' resize-vertical'}
            />
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={draft[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              className={inputCls}
            />
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          className="text-xs py-2 px-4 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-all"
        >
          Save changes
        </button>
        <button
          onClick={onCancel}
          className="text-xs py-2 px-4 rounded-lg font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-all"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  );
}

/** Small pencil button used next to Regen / Approve. */
function EditButton({ onClick, label = 'Edit', size = 'sm' }) {
  const cls =
    size === 'sm'
      ? 'text-xs py-1 px-3 rounded-lg font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-all'
      : 'text-sm py-2.5 px-5 rounded-lg font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-all';
  return (
    <button onClick={onClick} className={cls}>
      <Pencil className={`${size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} inline mr-1`} />
      {label}
    </button>
  );
}

export default function Step2_EpicApproval() {
  const {
    generatedEpics, approveEpic, approveStory, approveAC, approveTestCase,
    cancelEpic, regenerateEpic, regenerateStory, regenerateAC, regenerateTestCase,
    editEpic, editStory, editTestCase,
    setApprovedEpics, nextStep, previousStep
  } = useWorkflow();

  const [expandedEpics, setExpandedEpics] = useState({});
  const [regenerating, setRegenerating] = useState({});
  const [regenOpen, setRegenOpen] = useState({});
  const [editOpen, setEditOpen] = useState({});

  useEffect(() => {
    if (generatedEpics.length > 0) {
      const epicIds = new Set(generatedEpics.map(e => e.epic_id));
      const hasNewEpics = generatedEpics.some(e => !(e.epic_id in expandedEpics));
      const hasStaleKeys = Object.keys(expandedEpics).some(id => !epicIds.has(id));
      if (hasNewEpics || hasStaleKeys || Object.keys(expandedEpics).length === 0) {
        const initial = {};
        generatedEpics.forEach((epic, i) => {
          initial[epic.epic_id] = expandedEpics[epic.epic_id] ?? (i === 0);
        });
        setExpandedEpics(initial);
      }
    }
  }, [generatedEpics]);

  const toggleEpic = (epicId) => {
    setExpandedEpics(prev => ({ ...prev, [epicId]: !prev[epicId] }));
  };

  const approvedCount = generatedEpics.filter(e => e.approved).length;
  const totalStories = generatedEpics.reduce(
    (sum, e) => sum + (e.user_stories?.filter(s => s.approved).length || 0), 0
  );

  const openRegenInput = (key) => setRegenOpen(prev => ({ ...prev, [key]: true }));
  const closeRegenInput = (key) => setRegenOpen(prev => ({ ...prev, [key]: false }));

  // Editing and regenerating the same item at once would be two competing
  // sources of truth, so opening one closes the other.
  const openEdit = (key) => {
    setRegenOpen(prev => ({ ...prev, [key]: false }));
    setEditOpen(prev => ({ ...prev, [key]: true }));
  };
  const closeEdit = (key) => setEditOpen(prev => ({ ...prev, [key]: false }));

  const handleRegenerate = async (key, fn, requirements) => {
    setRegenerating(prev => ({ ...prev, [key]: true }));
    try {
      const result = await fn(requirements);
      if (!result?.success) {
        alert('Regeneration failed: ' + (result?.error || 'Unknown error'));
      } else {
        closeRegenInput(key);
      }
    } catch (error) {
      alert('Regeneration error: ' + error.message);
    } finally {
      setRegenerating(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleProceed = async () => {
    const approved = generatedEpics.filter(e => e.approved ||
      e.user_stories?.some(s => s.approved)
    ).map(epic => ({
      ...epic,
      user_stories: epic.user_stories?.filter(s => s.approved) || []
    }));
    if (approved.length === 0) {
      alert('Please approve at least one epic or user story before proceeding');
      return;
    }
    setApprovedEpics(approved);
    nextStep();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Review & Approve Epics</h2>
          <p className="text-gray-500 text-sm mt-1">
            Review generated epics and approve the ones you want to include
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-right">
          <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-1">Approved</div>
          <div className="text-lg font-bold text-teal-600">
            {approvedCount} <span className="text-xs text-gray-400 font-normal">epics</span>
            {' '}{totalStories} <span className="text-xs text-gray-400 font-normal">stories</span>
          </div>
        </div>
      </div>

      {/* Epic List */}
      <div className="space-y-3">
        {generatedEpics.map((epic, eIndex) => (
          <EpicCard
            key={epic.epic_id}
            epic={epic}
            eIndex={eIndex}
            expanded={expandedEpics[epic.epic_id]}
            onToggle={() => toggleEpic(epic.epic_id)}
            regenerating={regenerating}
            regenOpen={regenOpen}
            openRegenInput={openRegenInput}
            closeRegenInput={closeRegenInput}
            handleRegenerate={handleRegenerate}
            editOpen={editOpen}
            openEdit={openEdit}
            closeEdit={closeEdit}
            editEpic={editEpic}
            editStory={editStory}
            editTestCase={editTestCase}
            approveEpic={approveEpic}
            approveStory={approveStory}
            approveAC={approveAC}
            approveTestCase={approveTestCase}
            cancelEpic={cancelEpic}
            regenerateEpic={regenerateEpic}
            regenerateStory={regenerateStory}
            regenerateAC={regenerateAC}
            regenerateTestCase={regenerateTestCase}
          />
        ))}
      </div>

      {/* Navigation */}
      <div className="flex gap-3">
        <button onClick={previousStep} className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-xl border border-gray-200 hover:bg-gray-50 transition-all">
          Back
        </button>
        <motion.button
          onClick={handleProceed}
          disabled={approvedCount === 0 && totalStories === 0}
          className="flex-1 text-sm font-semibold bg-teal-500 text-white rounded-xl px-6 py-2.5
                     hover:bg-teal-600 active:scale-[0.98] transition-all
                     disabled:opacity-40 disabled:cursor-not-allowed"
          whileTap={{ scale: 0.98 }}
        >
          Proceed to Developer Analysis
        </motion.button>
      </div>
    </div>
  );
}

function EpicCard({
  epic, eIndex, expanded, onToggle,
  regenerating, regenOpen, openRegenInput, closeRegenInput, handleRegenerate,
  editOpen, openEdit, closeEdit, editEpic, editStory, editTestCase,
  approveEpic, approveStory, approveAC, approveTestCase,
  cancelEpic, regenerateEpic, regenerateStory, regenerateAC, regenerateTestCase
}) {
  return (
    <div
      className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all duration-300
        ${epic.approved ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200'}`}
    >
      {/* Epic Header */}
      <div
        onClick={onToggle}
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono bg-teal-100 text-teal-700 shrink-0">{epic.epic_id}</span>
          {epic.approved && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono bg-emerald-100 text-emerald-700 shrink-0"
            >
              <Check className="w-3 h-3 mr-0.5" /> Approved
            </motion.span>
          )}
          <span className="font-medium text-gray-900 truncate">{clean(epic.epic_title)}</span>
        </div>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-4 h-4 text-gray-400" />
        </motion.div>
      </div>

      {/* Epic Content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 space-y-4 pt-4 border-t border-gray-100">
              <p className="text-sm text-gray-600">{clean(epic.epic_description)}</p>

              {/* User Stories */}
              {epic.user_stories?.map((story, sIndex) => (
                <div
                  key={story.story_id}
                  className={`ml-3 pl-4 border-l-2 space-y-3 transition-colors duration-300
                    ${story.approved ? 'border-emerald-300' : 'border-gray-200'}`}
                >
                  {/* Story header */}
                  <div>
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-purple-100 text-purple-700">{story.story_id}</span>
                      {story.story_points && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-amber-100 text-amber-700">{story.story_points} pts</span>
                      )}
                      {story.approved && (
                        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-emerald-100 text-emerald-700">
                          Approved
                        </motion.span>
                      )}
                    </div>
                    <div className="text-sm font-medium text-gray-900">{clean(story.story_title)}</div>
                    <div className="text-sm text-gray-500 mt-1">{clean(story.story_description)}</div>
                  </div>

                  {/* Acceptance Criteria */}
                  {story.acceptance_criteria && (
                    <div className={`p-3.5 rounded-xl text-sm relative transition-all duration-300
                      ${story.ac_approved ? 'bg-emerald-50 border border-emerald-200' : 'bg-gray-50 border border-gray-200'}
                      ${regenerating[`ac-${story.story_id}`] ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      {regenerating[`ac-${story.story_id}`] && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-xl z-10 bg-white/80">
                          <span className="text-sm font-medium text-teal-600 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> Regenerating...
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-mono uppercase tracking-wider text-gray-400">Acceptance Criteria</span>
                        <div className="flex gap-2">
                          {!editOpen[`ac-${story.story_id}`] && (
                            <EditButton onClick={() => openEdit(`ac-${story.story_id}`)} />
                          )}
                          {!regenOpen[`ac-${story.story_id}`] && (
                            <button onClick={() => openRegenInput(`ac-${story.story_id}`)} className="text-xs py-1 px-3 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all">
                              <RefreshCw className="w-3 h-3 inline mr-1" />Regen
                            </button>
                          )}
                          {!story.ac_approved && (
                            <button onClick={() => approveAC(eIndex, sIndex)} className="text-xs py-1 px-3 rounded-lg font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-all">
                              Approve
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-gray-600 whitespace-pre-wrap text-[13px] leading-relaxed">
                        {clean(story.acceptance_criteria)}
                      </div>
                      <AnimatePresence>
                        {editOpen[`ac-${story.story_id}`] && (
                          <EditPanel
                            title="Acceptance Criteria"
                            componentId={story.story_id}
                            fields={[
                              { key: 'acceptance_criteria', label: 'Acceptance Criteria', value: story.acceptance_criteria, type: 'textarea', rows: 5 },
                            ]}
                            onCancel={() => closeEdit(`ac-${story.story_id}`)}
                            onSave={(patch) => { editStory(eIndex, sIndex, patch); closeEdit(`ac-${story.story_id}`); }}
                          />
                        )}
                      </AnimatePresence>
                      <AnimatePresence>
                        {regenOpen[`ac-${story.story_id}`] && (
                          <RegenInput
                            componentId={story.story_id}
                            label="Acceptance Criteria"
                            isLoading={regenerating[`ac-${story.story_id}`]}
                            onCancel={() => closeRegenInput(`ac-${story.story_id}`)}
                            onSubmit={(reqs) => handleRegenerate(
                              `ac-${story.story_id}`, (r) => regenerateAC(eIndex, sIndex, r), reqs
                            )}
                          />
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Test Cases */}
                  {story.test_cases?.map((tc, tcIndex) => (
                    <div
                      key={tc.test_case_id}
                      className={`p-3.5 rounded-xl text-sm relative transition-all duration-300
                        ${tc.approved ? 'bg-emerald-50 border border-emerald-200' : 'bg-gray-50 border border-gray-200'}
                        ${regenerating[`tc-${tc.test_case_id}`] ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      {regenerating[`tc-${tc.test_case_id}`] && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-xl z-10 bg-white/80">
                          <span className="text-sm font-medium text-teal-600 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> Regenerating...
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between mb-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-gray-100 text-gray-500">{tc.test_case_id}</span>
                        <div className="flex gap-2">
                          {!editOpen[`tc-${tc.test_case_id}`] && (
                            <EditButton onClick={() => openEdit(`tc-${tc.test_case_id}`)} />
                          )}
                          {!regenOpen[`tc-${tc.test_case_id}`] && (
                            <button onClick={() => openRegenInput(`tc-${tc.test_case_id}`)} className="text-xs py-1 px-3 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all">
                              <RefreshCw className="w-3 h-3 inline mr-1" />Regen
                            </button>
                          )}
                          {!tc.approved && (
                            <button onClick={() => approveTestCase(eIndex, sIndex, tcIndex)} className="text-xs py-1 px-3 rounded-lg font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-all">
                              Approve
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-gray-600 text-[13px]">{clean(tc.test_case_description)}</div>

                      {(tc.input_preconditions || tc.input_test_data || tc.input_user_action) && (
                        <div className="mt-2.5 p-3 rounded-lg bg-gray-50 border border-gray-200 space-y-1.5">
                          <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-1.5">Input</div>
                          {tc.input_preconditions && (
                            <div className="text-[13px]">
                              <span className="text-teal-700 font-medium">Preconditions: </span>
                              <span className="text-gray-600">{clean(tc.input_preconditions)}</span>
                            </div>
                          )}
                          {tc.input_test_data && (
                            <div className="text-[13px]">
                              <span className="text-teal-700 font-medium">Test Data: </span>
                              <span className="text-gray-600">{clean(tc.input_test_data)}</span>
                            </div>
                          )}
                          {tc.input_user_action && (
                            <div className="text-[13px]">
                              <span className="text-teal-700 font-medium">User Action: </span>
                              <span className="text-gray-600">{clean(tc.input_user_action)}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {tc.expected_results?.length > 0 && (
                        <div className="mt-2.5">
                          <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mb-1.5">Expected Result</div>
                          <ul className="ml-4 space-y-1 text-gray-600 text-[13px] list-disc">
                            {tc.expected_results.map((result, i) => (
                              <li key={i}>{clean(result)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <AnimatePresence>
                        {editOpen[`tc-${tc.test_case_id}`] && (
                          <EditPanel
                            title="Test Case"
                            componentId={tc.test_case_id}
                            fields={[
                              { key: 'test_case_description', label: 'Description', value: tc.test_case_description, type: 'textarea', rows: 2 },
                              { key: 'input_preconditions', label: 'Preconditions', value: tc.input_preconditions, type: 'textarea', rows: 2 },
                              { key: 'input_test_data', label: 'Test Data', value: tc.input_test_data, type: 'textarea', rows: 2 },
                              { key: 'input_user_action', label: 'User Action', value: tc.input_user_action, type: 'textarea', rows: 2 },
                              { key: 'expected_results', label: 'Expected Results (one per line)', value: tc.expected_results, type: 'list', rows: 4 },
                            ]}
                            onCancel={() => closeEdit(`tc-${tc.test_case_id}`)}
                            onSave={(patch) => { editTestCase(eIndex, sIndex, tcIndex, patch); closeEdit(`tc-${tc.test_case_id}`); }}
                          />
                        )}
                      </AnimatePresence>
                      <AnimatePresence>
                        {regenOpen[`tc-${tc.test_case_id}`] && (
                          <RegenInput
                            componentId={tc.test_case_id}
                            label="Test Case"
                            isLoading={regenerating[`tc-${tc.test_case_id}`]}
                            onCancel={() => closeRegenInput(`tc-${tc.test_case_id}`)}
                            onSubmit={(reqs) => handleRegenerate(
                              `tc-${tc.test_case_id}`, (r) => regenerateTestCase(eIndex, sIndex, tcIndex, r), reqs
                            )}
                          />
                        )}
                      </AnimatePresence>
                    </div>
                  ))}

                  {/* Story Actions */}
                  <div className="flex gap-2 flex-wrap">
                    <motion.button
                      onClick={() => approveStory(eIndex, sIndex)}
                      disabled={story.approved}
                      className={`text-xs py-2 px-4 rounded-lg font-medium transition-all duration-200
                        ${story.approved
                          ? 'bg-emerald-100 text-emerald-500 cursor-default'
                          : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 cursor-pointer'}`}
                      whileTap={!story.approved ? { scale: 0.95 } : {}}
                    >
                      {story.approved ? <><Check className="w-3 h-3 inline mr-1" />Story Approved</> : 'Approve Story'}
                    </motion.button>
                    {!regenOpen[`story-${story.story_id}`] && (
                      <button onClick={() => openRegenInput(`story-${story.story_id}`)} className="text-xs py-2 px-4 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all">
                        <RefreshCw className="w-3 h-3 inline mr-1" />Regenerate Story
                      </button>
                    )}
                    {!editOpen[`story-${story.story_id}`] && (
                      <button onClick={() => openEdit(`story-${story.story_id}`)} className="text-xs py-2 px-4 rounded-lg font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-all">
                        <Pencil className="w-3 h-3 inline mr-1" />Edit Story
                      </button>
                    )}
                  </div>
                  <AnimatePresence>
                    {editOpen[`story-${story.story_id}`] && (
                      <EditPanel
                        title="User Story"
                        componentId={story.story_id}
                        fields={[
                          { key: 'story_title', label: 'Title', value: story.story_title, type: 'text' },
                          { key: 'story_description', label: 'Description', value: story.story_description, type: 'textarea', rows: 3 },
                          { key: 'story_points', label: 'Story Points', value: story.story_points, type: 'number' },
                        ]}
                        onCancel={() => closeEdit(`story-${story.story_id}`)}
                        onSave={(patch) => { editStory(eIndex, sIndex, patch); closeEdit(`story-${story.story_id}`); }}
                      />
                    )}
                  </AnimatePresence>
                  <AnimatePresence>
                    {regenOpen[`story-${story.story_id}`] && (
                      <RegenInput
                        componentId={story.story_id}
                        label="User Story"
                        isLoading={regenerating[`story-${story.story_id}`]}
                        onCancel={() => closeRegenInput(`story-${story.story_id}`)}
                        onSubmit={(reqs) => handleRegenerate(
                          `story-${story.story_id}`, (r) => regenerateStory(eIndex, sIndex, r), reqs
                        )}
                      />
                    )}
                  </AnimatePresence>
                </div>
              ))}

              {/* Epic Actions */}
              <div className="flex gap-2 pt-3 flex-wrap border-t border-gray-100">
                <motion.button
                  onClick={() => { if (!epic.approved) { approveEpic(eIndex); onToggle(); } }}
                  disabled={epic.approved}
                  className={`text-sm py-2.5 px-5 rounded-lg font-medium transition-all duration-200
                    ${epic.approved
                      ? 'bg-emerald-100 text-emerald-500 cursor-default'
                      : 'bg-emerald-500 text-white hover:bg-emerald-600 cursor-pointer'}`}
                  whileTap={!epic.approved ? { scale: 0.95 } : {}}
                >
                  {epic.approved ? <><Check className="w-4 h-4 inline mr-1" />Epic Approved</> : 'Approve Epic'}
                </motion.button>
                {!regenOpen[`epic-${epic.epic_id}`] && (
                  <button onClick={() => openRegenInput(`epic-${epic.epic_id}`)} className="text-sm py-2.5 px-5 rounded-lg font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all">
                    <RefreshCw className="w-3.5 h-3.5 inline mr-1" />Regenerate
                  </button>
                )}
                {!editOpen[`epic-${epic.epic_id}`] && (
                  <EditButton size="lg" label="Edit Epic" onClick={() => openEdit(`epic-${epic.epic_id}`)} />
                )}
                <button
                  onClick={() => { if (confirm('Remove this epic?')) cancelEpic(eIndex); }}
                  className="text-sm py-2.5 px-5 rounded-lg font-medium text-red-500 bg-red-50
                           hover:bg-red-100 hover:text-red-600 transition-all duration-200"
                >
                  <Trash2 className="w-3.5 h-3.5 inline mr-1" />Remove
                </button>
              </div>
              <AnimatePresence>
                {editOpen[`epic-${epic.epic_id}`] && (
                  <EditPanel
                    title="Epic"
                    componentId={epic.epic_id}
                    fields={[
                      { key: 'epic_title', label: 'Title', value: epic.epic_title, type: 'text' },
                      { key: 'epic_description', label: 'Description', value: epic.epic_description, type: 'textarea', rows: 4 },
                    ]}
                    onCancel={() => closeEdit(`epic-${epic.epic_id}`)}
                    onSave={(patch) => { editEpic(eIndex, patch); closeEdit(`epic-${epic.epic_id}`); }}
                  />
                )}
              </AnimatePresence>
              <AnimatePresence>
                {regenOpen[`epic-${epic.epic_id}`] && (
                  <RegenInput
                    componentId={epic.epic_id}
                    label="Epic"
                    isLoading={regenerating[`epic-${epic.epic_id}`]}
                    onCancel={() => closeRegenInput(`epic-${epic.epic_id}`)}
                    onSubmit={(reqs) => handleRegenerate(
                      `epic-${epic.epic_id}`, (r) => regenerateEpic(eIndex, r), reqs
                    )}
                  />
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
