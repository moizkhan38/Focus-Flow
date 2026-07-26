import { useState, useMemo, useCallback } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, pointerWithin, rectIntersection } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Flame, RefreshCw, AlertCircle, X, Search, Columns3, WifiOff, Inbox } from 'lucide-react';
import { normalizeStatus } from '../../hooks/useKanbanSync';
import NotConnected from '../shared/NotConnected';

// ─── Column & Card Styling ────────────────────────────────────────────────
const colConfig = {
  'To Do': {
    header: 'bg-gray-50', dot: 'bg-gray-400', text: 'text-gray-600',
    dropHighlight: 'bg-gray-100 ring-gray-300',
    card: { bg: 'bg-white', border: 'border-gray-200 hover:border-gray-300', accent: 'border-l-gray-400', key: 'text-gray-500', sp: 'bg-gray-100 text-gray-600', grip: 'text-gray-300' },
  },
  'In Progress': {
    header: 'bg-blue-50', dot: 'bg-blue-500', text: 'text-blue-600',
    dropHighlight: 'bg-blue-50 ring-blue-300',
    card: { bg: 'bg-blue-50/40', border: 'border-blue-200 hover:border-blue-300', accent: 'border-l-blue-500', key: 'text-blue-600', sp: 'bg-blue-100 text-blue-600', grip: 'text-blue-300' },
  },
  'Done': {
    header: 'bg-emerald-50', dot: 'bg-emerald-500', text: 'text-emerald-600',
    dropHighlight: 'bg-emerald-50 ring-emerald-300',
    card: { bg: 'bg-emerald-50/40', border: 'border-emerald-200 hover:border-emerald-300', accent: 'border-l-emerald-500', key: 'text-emerald-600', sp: 'bg-emerald-100 text-emerald-600', grip: 'text-emerald-300' },
  },
};

// ─── Card Component ───────────────────────────────────────────────────────
function KanbanCard({ issue, column, isDragOverlay, isSyncing, variant }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.key,
    data: { issue },
    disabled: isSyncing,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.25 : 1,
  };

  const cc = colConfig[column]?.card || colConfig['To Do'].card;
  const isMini = variant === 'mini';

  return (
    <div
      ref={setNodeRef}
      style={isDragOverlay ? {} : style}
      {...attributes}
      {...listeners}
      className={`rounded-lg border border-l-[3px] transition-all ${isSyncing ? 'pointer-events-none opacity-60' : 'cursor-grab active:cursor-grabbing'} ${cc.accent} ${cc.bg} ${
        isDragOverlay ? 'shadow-xl ring-2 ring-teal-300 border-teal-400' : cc.border
      } ${isMini ? 'p-2.5' : 'p-3'}`}
    >
      <div className={`flex items-start ${isMini ? 'gap-1.5' : 'gap-2'}`}>
        <GripVertical className={`${isMini ? 'w-3 h-3' : 'w-4 h-4'} mt-0.5 shrink-0 ${cc.grip}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`font-mono font-medium ${cc.key} ${isMini ? 'text-[10px]' : 'text-xs'}`}>{issue.key}</span>
            {(issue.priority === 'Blocker' || issue.priority === 'Critical') && (
              <Flame className={`${isMini ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-red-500`} />
            )}
            {!isMini && issue.issueType && (
              <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">{issue.issueType}</span>
            )}
          </div>
          <p className={`font-medium text-gray-900 leading-snug ${isMini ? 'text-xs line-clamp-2' : 'text-sm'}`}>{issue.summary}</p>
          {!isMini && issue.epicName && (
            <p className="text-xs text-purple-600 mt-1">{issue.epicName}</p>
          )}
          <div className={`flex items-center gap-2 flex-wrap ${isMini ? 'mt-1' : 'mt-2'}`}>
            {issue.storyPoints != null && (
              <span className={`font-mono rounded px-1.5 py-0.5 ${cc.sp} ${isMini ? 'text-[10px]' : 'text-xs'}`}>{issue.storyPoints} SP</span>
            )}
            <span className={`${isMini ? 'text-[10px] text-gray-400' : 'text-xs rounded bg-teal-100 text-teal-700 px-1.5 py-0.5'}`}>
              {issue.assignee?.name || 'Unassigned'}
            </span>
            {!isMini && issue.priority && issue.priority !== 'Medium' && (
              <span className={`text-[10px] rounded px-1.5 py-0.5 ${
                issue.priority === 'Blocker' ? 'bg-red-100 text-red-700' :
                issue.priority === 'Critical' ? 'bg-red-100 text-red-600' :
                issue.priority === 'High' ? 'bg-amber-100 text-amber-700' :
                'bg-gray-100 text-gray-500'
              }`}>{issue.priority}</span>
            )}
          </div>
          {isSyncing && (
            <div className="flex items-center gap-1 mt-1.5 text-[10px] text-teal-600">
              <RefreshCw className="w-2.5 h-2.5 animate-spin" /> Syncing...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Column Component ─────────────────────────────────────────────────────
function KanbanColumn({ id, items, config, syncingKey, variant }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const isMini = variant === 'mini';
  const totalSP = items.reduce((s, i) => s + (i.storyPoints || 0), 0);

  return (
    <div ref={setNodeRef} className={`rounded-xl border p-3 flex flex-col transition-colors ${
      isOver ? `${config.dropHighlight} ring-2 ring-inset` : `${config.header} border-gray-200`
    } ${isMini ? 'min-h-[120px] md:min-h-[200px]' : 'min-h-[140px] md:min-h-[400px]'}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${config.dot}`} />
        <h2 className={`text-xs font-semibold ${config.text}`}>{id}</h2>
        <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-medium text-gray-600 shadow-sm border border-gray-100">
          {items.length}
        </span>
        {totalSP > 0 && (
          <span className="text-[10px] text-gray-400 font-mono">{totalSP}SP</span>
        )}
      </div>
      <div className={`space-y-1.5 flex-1 ${isMini ? 'max-h-[400px] overflow-y-auto' : ''}`}>
        {items.map(issue => (
          <KanbanCard key={issue.key} issue={issue} column={id} isSyncing={syncingKey === issue.key} variant={variant} />
        ))}
        {items.length === 0 && (
          <div className={`h-full flex items-center justify-center text-center text-xs rounded-lg border-2 border-dashed transition-colors ${
            isOver ? 'border-teal-300 text-teal-500 bg-teal-50/50' : 'border-gray-200 text-gray-400'
          } ${isMini ? 'min-h-[80px] md:min-h-[160px]' : 'min-h-[90px] md:min-h-[300px]'}`}>
            {isOver ? 'Drop here' : 'No items'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────
function KanbanSkeleton({ variant }) {
  const isMini = variant === 'mini';
  const cardCount = isMini ? 2 : 3;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
      {['To Do', 'In Progress', 'Done'].map(col => (
        <div key={col} className={`rounded-xl border border-gray-200 bg-gray-50 p-3 ${isMini ? 'min-h-[120px] md:min-h-[200px]' : 'min-h-[140px] md:min-h-[400px]'}`}>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-2 w-2 rounded-full bg-gray-300 animate-pulse" />
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: cardCount }).map((_, i) => (
              <div key={i} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                <div className="h-3 w-12 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-full rounded bg-gray-100 animate-pulse" />
                <div className="h-3 w-2/3 rounded bg-gray-100 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main KanbanBoard Component ───────────────────────────────────────────
/**
 * Unified kanban board used by both ProjectDetailPage (mini) and ProjectKanbanPage (full).
 *
 * @param {object} kanban - Return value of useKanbanSync hook
 * @param {'mini'|'full'} variant - Controls card size, column height, and filter visibility
 * @param {string} [title] - Optional title shown above the board
 */
export default function KanbanBoard({ kanban, variant = 'full', title }) {
  const [activeIssue, setActiveIssue] = useState(null);
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');

  const isMini = variant === 'mini';

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const findIssueByKey = useCallback((key) => {
    return (kanban.mergedIssues || []).find(i => i.key === key);
  }, [kanban.mergedIssues]);

  // Apply local filters (full variant only)
  const filteredColumns = useMemo(() => {
    if (isMini || (!search && !assigneeFilter)) return kanban.columns;

    const filtered = {};
    for (const [colName, issues] of Object.entries(kanban.columns)) {
      filtered[colName] = issues.filter(issue => {
        if (search && !issue.summary.toLowerCase().includes(search.toLowerCase()) && !issue.key.toLowerCase().includes(search.toLowerCase())) return false;
        if (assigneeFilter && (issue.assignee?.name || 'Unassigned') !== assigneeFilter) return false;
        return true;
      });
    }
    return filtered;
  }, [kanban.columns, search, assigneeFilter, isMini]);

  const handleDragStart = useCallback((event) => {
    setActiveIssue(findIssueByKey(event.active.id));
  }, [findIssueByKey]);

  const handleDragEnd = useCallback(async (event) => {
    setActiveIssue(null);
    const { active, over } = event;
    if (!over) return;

    const issueKey = active.id;
    let targetColumn = over.id;
    if (!['To Do', 'In Progress', 'Done'].includes(targetColumn)) {
      const overIssue = findIssueByKey(over.id);
      if (overIssue) {
        targetColumn = normalizeStatus(overIssue.status);
      } else {
        return;
      }
    }

    const issue = findIssueByKey(issueKey);
    if (!issue) return;
    if (normalizeStatus(issue.status) === targetColumn) return;

    kanban.moveIssue(issueKey, targetColumn);
  }, [findIssueByKey, kanban]);

  // Compute stats
  const totalIssues = kanban.storyIssues?.length || 0;
  const doneCount = kanban.columns?.['Done']?.length || 0;

  // ─── Empty / Error States ─────────────────────────────────────────────
  if (kanban.isNotSynced) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <Inbox className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">This project hasn't been synced to Jira yet.</p>
        <p className="text-xs text-gray-400 mt-1">Go to the Assign page to sync epics and stories.</p>
      </div>
    );
  }

  // Org hasn't connected Jira — offer the fix rather than an error to retry.
  if (kanban.jiraNotConnected) {
    return <NotConnected provider="jira" compact={isMini} />;
  }

  if (kanban.connectionError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
        <WifiOff className="w-8 h-8 text-red-300 mx-auto mb-2" />
        <p className="text-sm text-red-600">Unable to connect to Jira.</p>
        <p className="text-xs text-red-400 mt-1">{kanban.connectionError.message || 'Check your Jira credentials.'}</p>
        <button onClick={kanban.refresh} className="mt-3 text-xs text-red-600 hover:text-red-700 underline">Retry</button>
      </div>
    );
  }

  if (kanban.isLoading) {
    return <KanbanSkeleton variant={variant} />;
  }

  if (kanban.isEmpty) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <Columns3 className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No sprint issues found.</p>
        <p className="text-xs text-gray-400 mt-1">Sprint may not be active yet. Issues will appear once loaded.</p>
        <button onClick={kanban.refresh} className="mt-3 text-xs text-blue-600 hover:text-blue-700 underline">Refresh</button>
      </div>
    );
  }

  // ─── Board Header (mini only shows title bar) ─────────────────────────
  return (
    <div>
      {/* Status banners */}
      {kanban.moveError && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700 border border-red-200">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{kanban.moveError.message}</span>
          <button onClick={kanban.clearMoveError} className="rounded p-0.5 hover:bg-red-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {kanban.syncingKey && (
        <div className="mb-3 flex items-center gap-2 text-xs text-teal-600 bg-teal-50 rounded-lg px-3 py-2 border border-teal-200">
          <RefreshCw className="w-3 h-3 animate-spin" />
          Syncing {kanban.syncingKey} to Jira...
        </div>
      )}

      {/* Mini header */}
      {isMini && title && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Columns3 className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">Live — drag to move</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={kanban.refresh} className="text-[10px] text-gray-400 hover:text-teal-600 flex items-center gap-1 transition-colors">
              <RefreshCw className="w-3 h-3" /> Sync
            </button>
            {kanban.lastSyncedAt && (
              <span className="text-[10px] text-gray-300">
                {Math.round((Date.now() - kanban.lastSyncedAt.getTime()) / 1000)}s ago
              </span>
            )}
          </div>
        </div>
      )}

      {/* Full header with filters */}
      {!isMini && (
        <div className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="relative flex-1 basis-full sm:basis-auto sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search issues..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-900 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 outline-none"
            />
          </div>
          <select
            value={assigneeFilter}
            onChange={e => setAssigneeFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 outline-none"
          >
            <option value="">All Assignees</option>
            {kanban.assignees.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          {(search || assigneeFilter) && (
            <button onClick={() => { setSearch(''); setAssigneeFilter(''); }} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1">
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-400">{doneCount}/{totalIssues} done</span>
            <button onClick={kanban.refresh} className="text-xs text-gray-400 hover:text-teal-600 flex items-center gap-1 transition-colors px-3 py-1.5 rounded-lg border border-gray-200 hover:border-teal-300">
              <RefreshCw className="w-3 h-3" /> Sync from Jira
            </button>
          </div>
        </div>
      )}

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => {
          const pointerCollisions = pointerWithin(args);
          if (pointerCollisions.length > 0) return pointerCollisions;
          return rectIntersection(args);
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
          {Object.entries(filteredColumns).map(([name, items]) => (
            <KanbanColumn key={name} id={name} items={items} config={colConfig[name]} syncingKey={kanban.syncingKey} variant={variant} />
          ))}
        </div>
        <DragOverlay>
          {activeIssue ? (
            <KanbanCard issue={activeIssue} column={normalizeStatus(activeIssue.status)} isDragOverlay variant={variant} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Footer: last synced */}
      {!isMini && kanban.lastSyncedAt && (
        <div className="mt-3 text-right">
          <span className="text-[10px] text-gray-300">
            Last synced: {kanban.lastSyncedAt.toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
