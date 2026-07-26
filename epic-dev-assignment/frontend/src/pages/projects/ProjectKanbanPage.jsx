import { useParams, useNavigate, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useProjects } from '../../hooks/useProjects';
import { useKanbanSync } from '../../hooks/useKanbanSync';
import KanbanBoard from '../../components/kanban/KanbanBoard';
import { ArrowLeft, Columns3 } from 'lucide-react';

export default function ProjectKanbanPage() {
  const { projectId } = useParams();
  const { getProject, isLoaded } = useProjects();
  const navigate = useNavigate();
  const project = getProject(projectId);

  const kanban = useKanbanSync(project?.jiraProjectKey, project?.jiraSprintId);

  useEffect(() => {
    if (isLoaded && !project) navigate('/projects');
  }, [isLoaded, project, navigate]);

  if (!isLoaded || !project) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8">
      <Link to={`/projects/${projectId}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Project
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <Columns3 className="h-5 w-5 shrink-0 text-blue-600" />
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 break-words">{project.name} — Kanban</h1>
      </div>

      <KanbanBoard kanban={kanban} variant="full" />
    </div>
  );
}
