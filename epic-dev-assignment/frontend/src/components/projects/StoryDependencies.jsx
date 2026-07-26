import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link2, Link2Off, ChevronDown, AlertTriangle, ArrowRight, Plus, X } from 'lucide-react';

/**
 * Manage and display story dependencies within a project.
 * Dependencies stored as: project.dependencies = [{ from: storyId, to: storyId, type: 'blocks' }]
 */
export default function StoryDependencies({ project, onUpdateDependencies }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fromStory, setFromStory] = useState('');
  const [toStory, setToStory] = useState('');

  const dependencies = project.dependencies || [];

  // Flatten all stories for selection
  const allStories = useMemo(() => {
    const stories = [];
    (project.epics || []).forEach((epic) => {
      (epic.stories || []).forEach((story) => {
        stories.push({
          id: story.id,
          title: story.title,
          epicTitle: epic.title,
          epicId: epic.id,
          storyPoints: story.storyPoints || 0,
        });
      });
    });
    return stories;
  }, [project.epics]);

  // Identify blocked stories (stories that depend on incomplete stories)
  const blockedStories = useMemo(() => {
    const blocked = new Set();
    const doneStatuses = ['done', 'closed', 'resolved'];
    dependencies.forEach((dep) => {
      const fromStoryData = allStories.find((s) => s.id === dep.from);
      if (fromStoryData) {
        // Check if the blocking story is not done
        const epicData = (project.epics || []).find((e) => e.id === fromStoryData.epicId);
        const storyData = epicData?.stories?.find((s) => s.id === dep.from);
        if (storyData && !doneStatuses.includes((storyData.status || '').toLowerCase())) {
          blocked.add(dep.to);
        }
      }
    });
    return blocked;
  }, [dependencies, allStories, project.epics]);

  const handleAdd = () => {
    if (!fromStory || !toStory || fromStory === toStory) return;
    // Check for duplicate
    const exists = dependencies.some((d) => d.from === fromStory && d.to === toStory);
    if (exists) return;
    onUpdateDependencies([...dependencies, { from: fromStory, to: toStory, type: 'blocks' }]);
    setFromStory('');
    setToStory('');
    setAdding(false);
  };

  const handleRemove = (index) => {
    onUpdateDependencies(dependencies.filter((_, i) => i !== index));
  };

  const getStoryLabel = (storyId) => {
    const s = allStories.find((st) => st.id === storyId);
    return s ? `${s.id}: ${s.title}` : storyId;
  };

  if (allStories.length < 2) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 transition-colors text-left sm:px-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Link2 className="w-4 h-4 text-indigo-500" />
          <span className="text-sm font-semibold text-gray-900">Story Dependencies</span>
          <span className="text-xs text-gray-400">
            {dependencies.length} link{dependencies.length !== 1 ? 's' : ''}
          </span>
          {blockedStories.size > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              <AlertTriangle className="w-3 h-3" />
              {blockedStories.size} blocked
            </span>
          )}
        </div>
        <motion.div animate={{ rotate: isExpanded ? 180 : 0 }}>
          <ChevronDown className="w-4 h-4 text-gray-400" />
        </motion.div>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-gray-100 pt-3 sm:px-5">
              {dependencies.length > 0 ? (
                <div className="space-y-2 mb-3">
                  {dependencies.map((dep, i) => {
                    const isBlocked = blockedStories.has(dep.to);
                    return (
                      <div
                        key={i}
                        className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                          isBlocked ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50'
                        }`}
                      >
                        <span className="font-medium text-gray-700 truncate flex-1 basis-full sm:basis-0">{getStoryLabel(dep.from)}</span>
                        <span className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                          <ArrowRight className="w-3 h-3" /> blocks
                        </span>
                        <span className={`font-medium truncate flex-1 ${isBlocked ? 'text-amber-700' : 'text-gray-700'}`}>
                          {getStoryLabel(dep.to)}
                        </span>
                        {isBlocked && <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                        <button
                          onClick={() => handleRemove(i)}
                          className="flex-shrink-0 rounded p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-400 mb-3">No dependencies defined. Add links to track story blocking relationships.</p>
              )}

              {adding ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={fromStory}
                    onChange={(e) => setFromStory(e.target.value)}
                    className="flex-1 min-w-[140px] rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  >
                    <option value="">Blocking story...</option>
                    {allStories.map((s) => (
                      <option key={s.id} value={s.id}>{s.id}: {s.title}</option>
                    ))}
                  </select>
                  <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
                  <select
                    value={toStory}
                    onChange={(e) => setToStory(e.target.value)}
                    className="flex-1 min-w-[140px] rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  >
                    <option value="">Blocked story...</option>
                    {allStories.filter((s) => s.id !== fromStory).map((s) => (
                      <option key={s.id} value={s.id}>{s.id}: {s.title}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAdd}
                    disabled={!fromStory || !toStory}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-40"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAdding(false); setFromStory(''); setToStory(''); }}
                    className="rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                >
                  <Plus className="w-3 h-3" /> Add Dependency
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
