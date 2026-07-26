import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, CheckCircle2, AlertCircle, ArrowRight, Download, FileText, FileSpreadsheet, FileJson } from 'lucide-react';
import ReportGenerator from '../reports/ReportGenerator';
import { exportToPDF, exportToCSV, exportToJSON } from '../../utils/export';

export default function SprintCompletionModal({
  report,
  isOpen,
  onClose,
  onComplete,
  completing,
  completionResult,
  completionError,
}) {
  const [activeExport, setActiveExport] = useState(null);

  if (!isOpen) return null;

  const handleExport = (type) => {
    setActiveExport(type);
    try {
      if (type === 'pdf') exportToPDF(report);
      else if (type === 'csv') exportToCSV(report);
      else if (type === 'json') exportToJSON(report);
    } catch (e) {
      console.error('Export failed:', e);
    }
    setTimeout(() => setActiveExport(null), 1000);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm p-4 pt-12"
        onClick={(e) => { if (e.target === e.currentTarget && !completing) onClose(); }}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.97 }}
          className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-gray-200 mb-12"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4 sm:px-6">
            <h2 className="text-lg font-semibold text-gray-900">
              {completionResult ? 'Sprint Completed' : 'Complete Sprint'}
            </h2>
            {!completing && (
              <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Post-completion success view */}
          {completionResult ? (
            <div className="p-4 sm:p-6 space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                <div className="flex items-center gap-2 text-emerald-700 mb-3">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-semibold">Sprint completed successfully!</span>
                </div>
                <div className="space-y-1.5 text-sm text-emerald-600">
                  <p>Sprint "{completionResult.closedSprint?.name}" has been closed.</p>
                  {completionResult.movedIssues > 0 && (
                    <p>{completionResult.movedIssues} incomplete {completionResult.movedIssues === 1 ? 'story' : 'stories'} moved to the next sprint.</p>
                  )}
                  {completionResult.nextSprint && (
                    <p>"{completionResult.nextSprint.name}" is now active.</p>
                  )}
                  {completionResult.isLastSprint && (
                    <p className="font-medium">All sprints are complete. Project marked as finished!</p>
                  )}
                </div>
              </div>

              {/* Export buttons */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Export report:</span>
                <button onClick={() => handleExport('pdf')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                  <FileText className="h-3.5 w-3.5" /> PDF
                </button>
                <button onClick={() => handleExport('csv')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                  <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
                </button>
                <button onClick={() => handleExport('json')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                  <FileJson className="h-3.5 w-3.5" /> JSON
                </button>
              </div>

              <div className="flex justify-end pt-2">
                <button onClick={onClose} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
                  Close
                </button>
              </div>
            </div>
          ) : (
            /* Pre-completion: report preview + action */
            <div className="p-4 sm:p-6 space-y-5">
              {/* Sprint Report Preview */}
              {report && <ReportGenerator report={report} />}

              {/* Export buttons */}
              {report && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-gray-500">Export:</span>
                  <button onClick={() => handleExport('pdf')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    <FileText className="h-3.5 w-3.5" /> PDF
                  </button>
                  <button onClick={() => handleExport('csv')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
                  </button>
                  <button onClick={() => handleExport('json')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    <FileJson className="h-3.5 w-3.5" /> JSON
                  </button>
                </div>
              )}

              {/* Error */}
              {completionError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {completionError}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-gray-100">
                <button
                  onClick={onClose}
                  disabled={completing}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={onComplete}
                  disabled={completing}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:bg-gray-300 transition-colors"
                >
                  {completing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Completing...
                    </>
                  ) : (
                    <>
                      Complete Sprint
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
