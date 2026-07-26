import { useParams, useNavigate, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useProjects } from '../../hooks/useProjects';
import { ArrowLeft, CheckCheck, XOctagon, ChevronRight } from 'lucide-react';
import EpicCard from '../../components/projects/EpicCard';
import EditModal from '../../components/projects/EditModal';
import SyncButton from '../../components/projects/SyncButton';

export default function VerifyPage() {
  const { projectId } = useParams();
  const {
    getProject, updateEpicStatus, updateStoryStatus,
    updateEpic, updateStory, bulkUpdateStatus, updateProject, isLoaded,
  } = useProjects();
  const navigate = useNavigate();
  const [editModal, setEditModal] = useState(null);

  const project = getProject(projectId);

  useEffect(() => {
    if (isLoaded && !project) navigate('/projects');
  }, [isLoaded, project, navigate]);

  if (!isLoaded || !project) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  const allItems = [];
  project.epics.forEach((e) => {
    allItems.push({ status: e.status });
    e.stories.forEach((s) => allItems.push({ status: s.status }));
  });
  const approved = allItems.filter((i) => i.status === 'approved').length;
  const pending = allItems.filter((i) => i.status === 'pending').length;
  const rejected = allItems.filter((i) => i.status === 'rejected').length;

  const handleEpicEdit = (epic) => {
    setEditModal({ type: 'epic', epicId: epic.id, title: epic.title, description: epic.description });
  };

  const handleStoryEdit = (epicId, story) => {
    setEditModal({
      type: 'story', epicId, storyId: story.id,
      title: story.title, description: story.description, acceptanceCriteria: story.acceptanceCriteria,
    });
  };

  const handleEditSave = (data) => {
    if (!editModal) return;
    if (editModal.type === 'epic') {
      updateEpic(projectId, editModal.epicId, { title: data.title, description: data.description });
    } else if (editModal.storyId) {
      updateStory(projectId, editModal.epicId, editModal.storyId, {
        title: data.title, description: data.description, acceptanceCriteria: data.acceptanceCriteria,
      });
    }
    setEditModal(null);
  };

  const handleSyncComplete = (results, sprintId, jiraProjectKey, jiraBoardId) => {
    for (const result of results) {
      updateEpic(projectId, result.epicId, { jiraKey: result.epicKey });
      for (const story of result.stories) {
        updateStory(projectId, result.epicId, story.storyId, { jiraKey: story.storyKey });
      }
    }
    updateProject(projectId, {
      status: 'synced',
      jiraSprintId: sprintId,
      jiraProjectKey,
      jiraBoardId,
    });
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <Link to={`/projects/${projectId}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" />
        Back to Project
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Review &amp; Verify</h1>
          <p className="mt-1 text-sm text-gray-500 break-words">{project.name}</p>
        </div>
        <Link
          to={`/projects/${projectId}/assign`}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Assign Developers
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total', value: allItems.length, style: 'border-gray-200 bg-white text-gray-900' },
          { label: 'Approved', value: approved, style: 'border-green-200 bg-green-50 text-green-700' },
          { label: 'Pending', value: pending, style: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
          { label: 'Rejected', value: rejected, style: 'border-red-200 bg-red-50 text-red-700' },
        ].map(({ label, value, style }) => (
          <div key={label} className={`rounded-lg border p-4 text-center ${style}`}>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs">{label}</p>
          </div>
        ))}
      </div>

      {/* Bulk Actions */}
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => bulkUpdateStatus(projectId, 'approved')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-xs font-medium text-green-700 hover:bg-green-100"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          Approve All
        </button>
        <button
          onClick={() => bulkUpdateStatus(projectId, 'rejected')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          <XOctagon className="h-3.5 w-3.5" />
          Reject All
        </button>
      </div>

      {/* Epics List */}
      <div className="space-y-4">
        {project.epics.map((epic) => (
          <EpicCard
            key={epic.id}
            epic={epic}
            projectId={projectId}
            onApprove={(epicId) => updateEpicStatus(projectId, epicId, 'approved')}
            onReject={(epicId) => updateEpicStatus(projectId, epicId, 'rejected')}
            onEdit={handleEpicEdit}
            onStoryApprove={(epicId, storyId) => updateStoryStatus(projectId, epicId, storyId, 'approved')}
            onStoryReject={(epicId, storyId) => updateStoryStatus(projectId, epicId, storyId, 'rejected')}
            onStoryEdit={handleStoryEdit}
          />
        ))}
      </div>

      {/* Jira Sync */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Sync to Jira</h2>
        <SyncButton
          epics={project.epics}
          assignments={project.assignments || []}
          projectName={project.name}
          sprintCount={project.sprintCount || 1}
          deadline={project.deadline || null}
          developerJiraMap={(project.analyzedDevelopers || []).reduce((m, d) => {
            if (d.jiraUsername) m[d.username] = d.jiraUsername;
            return m;
          }, {})}
          onSyncComplete={handleSyncComplete}
        />
      </div>

      {editModal && (
        <EditModal
          type={editModal.type}
          title={editModal.title}
          description={editModal.description}
          acceptanceCriteria={editModal.acceptanceCriteria}
          onSave={handleEditSave}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}
