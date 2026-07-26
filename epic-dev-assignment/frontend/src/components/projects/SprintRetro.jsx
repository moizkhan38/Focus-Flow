import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Plus, X, MessageSquare, ThumbsUp, AlertTriangle, Target, Save } from 'lucide-react';
import { useRetro } from '../../hooks/useRetro';

export default function SprintRetro({ projectId }) {
  const { getRetro, saveRetro } = useRetro();
  const [isExpanded, setIsExpanded] = useState(false);
  const existing = getRetro(projectId);

  const [wentWell, setWentWell] = useState(existing?.wentWell || []);
  const [toImprove, setToImprove] = useState(existing?.toImprove || []);
  const [actionItems, setActionItems] = useState(existing?.actionItems || []);
  const [newItem, setNewItem] = useState('');
  const [activeCategory, setActiveCategory] = useState('wentWell');
  const [hasChanges, setHasChanges] = useState(false);

  // Sync from storage if another component updates
  useEffect(() => {
    const stored = getRetro(projectId);
    if (stored) {
      setWentWell(stored.wentWell || []);
      setToImprove(stored.toImprove || []);
      setActionItems(stored.actionItems || []);
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addItem = () => {
    if (!newItem.trim()) return;
    const setter = activeCategory === 'wentWell' ? setWentWell : activeCategory === 'toImprove' ? setToImprove : setActionItems;
    setter((prev) => [...prev, newItem.trim()]);
    setNewItem('');
    setHasChanges(true);
  };

  const removeItem = (category, index) => {
    const setter = category === 'wentWell' ? setWentWell : category === 'toImprove' ? setToImprove : setActionItems;
    setter((prev) => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleSave = () => {
    saveRetro(projectId, { wentWell, toImprove, actionItems });
    setHasChanges(false);
  };

  const categories = [
    { key: 'wentWell', label: 'Went Well', icon: ThumbsUp, color: 'text-emerald-600 bg-emerald-50 border-emerald-200', items: wentWell },
    { key: 'toImprove', label: 'To Improve', icon: AlertTriangle, color: 'text-amber-600 bg-amber-50 border-amber-200', items: toImprove },
    { key: 'actionItems', label: 'Action Items', icon: Target, color: 'text-blue-600 bg-blue-50 border-blue-200', items: actionItems },
  ];

  const totalItems = wentWell.length + toImprove.length + actionItems.length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 transition-colors text-left sm:px-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <MessageSquare className="w-4 h-4 text-violet-500" />
          <span className="text-sm font-semibold text-gray-900">Sprint Retrospective</span>
          {totalItems > 0 && (
            <span className="text-xs text-gray-400">{totalItems} note{totalItems !== 1 ? 's' : ''}</span>
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
              {/* Category tabs */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {categories.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setActiveCategory(cat.key)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                      activeCategory === cat.key ? cat.color : 'text-gray-400 bg-white border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <cat.icon className="w-3 h-3" />
                    {cat.label} ({cat.items.length})
                  </button>
                ))}
              </div>

              {/* Items list */}
              {categories.map((cat) => (
                activeCategory === cat.key && (
                  <div key={cat.key} className="space-y-1.5 mb-3">
                    {cat.items.length === 0 ? (
                      <p className="text-xs text-gray-400 py-2">No items yet. Add your first note below.</p>
                    ) : (
                      cat.items.map((item, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2"
                        >
                          <span className="text-xs text-gray-700 flex-1">{item}</span>
                          <button
                            onClick={() => removeItem(cat.key, i)}
                            className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </motion.div>
                      ))
                    )}
                  </div>
                )
              ))}

              {/* Add item */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addItem()}
                  placeholder={`Add to "${categories.find((c) => c.key === activeCategory)?.label || 'category'}"...`}
                  className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700 placeholder:text-gray-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
                />
                <button
                  onClick={addItem}
                  disabled={!newItem.trim()}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 transition-colors disabled:opacity-40"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>

              {/* Save button */}
              {hasChanges && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3 flex justify-end"
                >
                  <button
                    onClick={handleSave}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-violet-700 transition-colors"
                  >
                    <Save className="w-3 h-3" />
                    Save Retrospective
                  </button>
                </motion.div>
              )}

              {existing?.updatedAt && !hasChanges && (
                <p className="mt-2 text-[10px] text-gray-400">
                  Last updated: {new Date(existing.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
