import { useState } from 'react';
import { CheckCircle2, XCircle, Clock, Pencil, ChevronDown, ClipboardCheck, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function StatusIcon({ status }) {
  if (status === 'approved') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === 'rejected') return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-yellow-500" />;
}

export default function StoryCard({ story, epicId, onApprove, onReject, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const hasAC = !!story.acceptanceCriteria;
  const hasTC = story.testCases?.length > 0;
  const expandable = hasAC || hasTC;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 py-3 pl-6 sm:px-5 sm:pl-12">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 basis-full sm:basis-0">
          <StatusIcon status={story.status} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium uppercase text-blue-600">Story</span>
              <span className="text-sm font-medium text-gray-900 truncate">{story.title}</span>
              {story.jiraKey && (
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {story.jiraKey}
                </span>
              )}
              {story.storyPoints > 0 && (
                <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-mono text-gray-500">
                  {story.storyPoints} SP
                </span>
              )}
              {hasAC && <ClipboardCheck className="w-3 h-3 text-emerald-400" />}
              {hasTC && <FileText className="w-3 h-3 text-blue-400" />}
            </div>
            <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{story.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto sm:ml-3">
          {expandable && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              title={expanded ? 'Hide details' : 'Show AC & test cases'}
            >
              <motion.div animate={{ rotate: expanded ? 180 : 0 }}>
                <ChevronDown className="h-4 w-4" />
              </motion.div>
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(epicId, story)}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              title="Edit"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {story.status !== 'approved' && onApprove && (
            <button
              onClick={() => onApprove(epicId, story.id)}
              className="rounded-md bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100"
            >
              Approve
            </button>
          )}
          {story.status !== 'rejected' && onReject && (
            <button
              onClick={() => onReject(epicId, story.id)}
              className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              Reject
            </button>
          )}
        </div>
      </div>

      {/* Expandable AC & TC */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="pl-6 pr-4 pb-3 space-y-3 sm:pl-12 sm:pr-5">
              {/* Acceptance Criteria */}
              {hasAC && (
                <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <ClipboardCheck className="w-3 h-3 text-emerald-600" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Acceptance Criteria</span>
                  </div>
                  <p className="text-xs text-gray-700 whitespace-pre-line">{story.acceptanceCriteria}</p>
                </div>
              )}

              {/* Test Cases */}
              {hasTC && story.testCases.map((tc, i) => (
                <div key={i} className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-3 h-3 text-blue-600" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">Test Case</span>
                    {tc.id && <span className="text-[10px] font-mono bg-blue-100 text-blue-600 rounded px-1.5 py-0.5">{tc.id}</span>}
                  </div>
                  {tc.description && <p className="text-xs text-gray-700 mb-2">{tc.description}</p>}
                  <div className="space-y-2">
                    {tc.preconditions && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Preconditions</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.preconditions}</p>
                      </div>
                    )}
                    {tc.testData && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Test Data</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.testData}</p>
                      </div>
                    )}
                    {tc.userAction && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Steps</span>
                        <p className="text-xs text-gray-600 mt-0.5">{tc.userAction}</p>
                      </div>
                    )}
                    {tc.expectedResults?.length > 0 && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">Expected Results</span>
                        <ol className="mt-1 space-y-0.5 list-decimal list-inside">
                          {tc.expectedResults.map((r, j) => (
                            <li key={j} className="text-xs text-gray-600">{r}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
