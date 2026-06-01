import { useEffect, useState } from 'react';
import { fetchWorkflows } from '../api/workflows';
import StatusBadge from './StatusBadge';
import type { WorkflowRun } from '@dynflow/shared';

export default function WorkflowList({
  onSelect,
  onError,
}: {
  onSelect: (id: string) => void;
  onError?: (message: string) => void;
}) {
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetchWorkflows();
      setWorkflows(res.data);
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

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div style={{ color: 'red' }}>Error: {error}</div>;
  if (workflows.length === 0) return <div>No workflows yet. Create your first workflow.</div>;

  return (
    <div>
      <h2>Workflows</h2>
      {workflows.map((wf) => (
        <div
          key={wf.id}
          onClick={() => onSelect(wf.id)}
          style={{
            cursor: 'pointer',
            padding: '8px',
            border: '1px solid #ddd',
            margin: '4px 0',
            borderRadius: '4px',
          }}
        >
          <strong>{wf.name}</strong>
          {' '}
          <StatusBadge status={wf.status} />
          <div style={{ fontSize: '0.85rem', color: '#666' }}>
            {wf.phases.length} phase(s) | {wf.phases.reduce((s, p) => s + p.agents.length, 0)} agent(s) | {new Date(wf.createdAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
