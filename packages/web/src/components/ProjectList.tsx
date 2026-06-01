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
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPrompt, setNewProjectPrompt] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreateAndRun = async () => {
    const name = newProjectName.trim();
    const prompt = newProjectPrompt.trim();
    if (!name || !prompt) return;
    setCreating(true);
    try {
      const { runProject } = await import('../api/projects');
      await runProject(name, prompt);
      setNewProjectName('');
      setNewProjectPrompt('');
      // Reload project list
      const data = await fetchProjects();
      setProjects(data);
      onSelect(name);
    } catch (e) {
      onError?.(String(e));
    } finally {
      setCreating(false);
    }
  };

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
          No projects yet. Enter a project name and prompt to create your first project.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 400 }}>
          <input
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="Project name (e.g. mathquest)"
            style={{
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontFamily: 'inherit',
            }}
          />
          <textarea
            value={newProjectPrompt}
            onChange={(e) => setNewProjectPrompt(e.target.value)}
            placeholder="Describe what to generate..."
            rows={3}
            style={{
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontFamily: 'inherit',
              resize: 'vertical',
              lineHeight: 1.4,
            }}
          />
          <button
            onClick={handleCreateAndRun}
            disabled={creating || !newProjectName.trim() || !newProjectPrompt.trim()}
            style={{
              padding: '8px 20px',
              backgroundColor: creating || !newProjectName.trim() || !newProjectPrompt.trim() ? '#d1d5db' : '#0891b2',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: creating || !newProjectName.trim() || !newProjectPrompt.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? 'Creating...' : 'Create & Run Project'}
          </button>
        </div>
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
