import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Pencil } from 'lucide-react';
import StoryCard from './StoryCard';

function StatusIcon({ status }) {
  if (status === 'approved') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === 'rejected') return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-yellow-500" />;
}

export default function EpicCard({ epic, projectId, onApprove, onReject, onEdit, onStoryApprove, onStoryReject, onStoryEdit }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {/* Epic Header */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 border-b border-gray-100 px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 basis-full sm:basis-0">
          <button onClick={() => setExpanded(!expanded)} className="flex-shrink-0 text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <StatusIcon status={epic.status} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium uppercase text-purple-600">Epic</span>
              <h3 className="font-semibold text-gray-900 truncate">{epic.title}</h3>
              {epic.jiraKey && (
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {epic.jiraKey}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-gray-500 line-clamp-1">{epic.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto sm:ml-3">
          {onEdit && (
            <button
              onClick={() => onEdit(epic)}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              title="Edit"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {epic.status !== 'approved' && onApprove && (
            <button
              onClick={() => onApprove(epic.id)}
              className="rounded-md bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100"
            >
              Approve
            </button>
          )}
          {epic.status !== 'rejected' && onReject && (
            <button
              onClick={() => onReject(epic.id)}
              className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              Reject
            </button>
          )}
        </div>
      </div>

      {/* Stories */}
      {expanded && epic.stories && epic.stories.length > 0 && (
        <div className="divide-y divide-gray-50">
          {epic.stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              epicId={epic.id}
              onApprove={onStoryApprove}
              onReject={onStoryReject}
              onEdit={onStoryEdit}
            />
          ))}
        </div>
      )}

      {expanded && (!epic.stories || epic.stories.length === 0) && (
        <p className="px-6 py-4 text-sm text-gray-400 sm:px-12">No stories in this epic.</p>
      )}
    </div>
  );
}
