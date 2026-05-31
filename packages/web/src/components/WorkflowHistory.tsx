import { useState, useEffect, useCallback } from 'react';
import { get } from '../api/client.js';
import StatusBadge from './StatusBadge';
import type { WorkflowRun, ApiResponse } from '@dynflow/shared';

export interface WorkflowHistoryProps {
  templateId: string;
  onSelectRun: (id: string) => void;
  onClone: (runId: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#1f2937',
    margin: 0,
  },
  placeholderContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    padding: '32px 20px',
    border: '2px dashed #d1d5db',
    borderRadius: '8px',
    backgroundColor: '#f9fafb',
  },
  placeholderIcon: {
    fontSize: '1.5rem',
    color: '#9ca3af',
  },
  placeholderTitle: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#4b5563',
    margin: 0,
  },
  placeholderText: {
    fontSize: '0.8125rem',
    color: '#6b7280',
    textAlign: 'center' as const,
    lineHeight: 1.5,
    margin: 0,
    maxWidth: '320px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  runItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  runInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  runNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  runName: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#1f2937',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  runMeta: {
    fontSize: '0.75rem',
    color: '#9ca3af',
  },
  cloneButton: {
    padding: '4px 12px',
    backgroundColor: '#fff',
    color: '#059669',
    border: '1px solid #6ee7b7',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  cloneButtonHover: {
    borderColor: '#10b981',
  },
  stateMessage: {
    padding: '20px',
    textAlign: 'center' as const,
    color: '#6b7280',
    fontSize: '0.9rem',
  },
  errorBox: {
    padding: '8px 12px',
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    borderRadius: '6px',
    fontSize: '0.875rem',
  },
  countPill: {
    fontSize: '0.7rem',
    padding: '2px 10px',
    borderRadius: '10px',
    backgroundColor: '#e5e7eb',
    color: '#374151',
    fontWeight: 600,
  },
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function WorkflowHistory({
  templateId,
  onSelectRun,
  onClone,
}: WorkflowHistoryProps) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiMissing, setApiMissing] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      setLoading(true);
      setApiMissing(false);
      const res = await get<ApiResponse<WorkflowRun[]>>(
        `/api/templates/${templateId}/runs`,
      );
      if (res.success && res.data) {
        setRuns(res.data);
        setError(null);
      } else {
        setError(res.error || 'Failed to load runs');
      }
    } catch (e) {
      const msg = String(e);
      // If the endpoint doesn't exist (404), show placeholder
      if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
        setApiMissing(true);
        setRuns([]);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Auto-refresh every 5 seconds when there are running runs
  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'running' || r.status === 'pending');
    if (!hasActive) return;
    const interval = setInterval(loadRuns, 5000);
    return () => clearInterval(interval);
  }, [runs, loadRuns]);

  function handleCloneClick(e: React.MouseEvent, runId: string) {
    e.stopPropagation();
    onClone(runId);
  }

  // Loading state
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h3 style={styles.title}>Run History</h3>
        </div>
        <div style={styles.stateMessage}>Loading run history...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h3 style={styles.title}>Run History</h3>
        </div>
        <div style={styles.errorBox}>{error}</div>
      </div>
    );
  }

  // Placeholder state when API endpoint doesn't exist yet
  if (apiMissing) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h3 style={styles.title}>Run History</h3>
        </div>
        <div style={styles.placeholderContainer}>
          <div style={styles.placeholderIcon}>⏳</div>
          <h4 style={styles.placeholderTitle}>Run History Coming Soon</h4>
          <p style={styles.placeholderText}>
            This feature will show all workflow runs created from this template.
            You'll be able to view run status, clone previous runs, and track
            execution history. The API endpoint is not yet available.
          </p>
        </div>
      </div>
    );
  }

  // Empty state (API exists but no runs)
  if (runs.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h3 style={styles.title}>Run History</h3>
        </div>
        <div style={styles.stateMessage}>No runs yet for this template.</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.title}>Run History</h3>
        <span style={styles.countPill}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={styles.list}>
        {runs.map((run) => (
          <div
            key={run.id}
            style={styles.runItem}
            onClick={() => onSelectRun(run.id)}
          >
            <div style={styles.runInfo}>
              <div style={styles.runNameRow}>
                <span style={styles.runName}>{run.name}</span>
                <StatusBadge status={run.status} />
              </div>
              <div style={styles.runMeta}>
                {run.phases.length} phase{run.phases.length !== 1 ? 's' : ''} ·{' '}
                {formatTime(run.createdAt)}
              </div>
            </div>
            <button
              style={styles.cloneButton}
              onClick={(e) => handleCloneClick(e, run.id)}
              title="Clone this run as a new template"
            >
              Clone
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
