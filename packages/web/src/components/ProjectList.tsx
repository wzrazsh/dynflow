import { useEffect, useState } from 'react';
import { fetchProjects } from '../api/projects';
import type { ProjectMeta } from '@dynflow/shared';

export default function ProjectList({
  onSelect,
  onNewProject,
  onError,
}: {
  onSelect: (name: string) => void;
  onNewProject?: () => void;
  onError?: (message: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await fetchProjects();
      setProjects(data);
      setError(null);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      onError?.(`Network error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div style={{ color: 'red' }}>Error: {error}</div>;
  if (projects.length === 0) {
    return (
      <div>
        <div style={{ marginBottom: 16, color: '#6b7280', fontSize: '0.875rem' }}>
          No projects yet. Create your first project by running a workflow with file output.
        </div>
        {onNewProject && (
          <button
            onClick={onNewProject}
            style={{
              padding: '8px 20px',
              backgroundColor: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + New Project
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2>Projects</h2>
      {projects.map((proj) => (
        <div
          key={proj.projectName}
          onClick={() => onSelect(proj.projectName)}
          style={{
            cursor: 'pointer',
            padding: '8px',
            border: '1px solid #ddd',
            margin: '4px 0',
            borderRadius: '4px',
          }}
        >
          <strong>{proj.projectName}</strong>
          <div style={{ fontSize: '0.85rem', color: '#666' }}>
            v{proj.currentVersion} | Updated: {new Date(proj.updatedAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
