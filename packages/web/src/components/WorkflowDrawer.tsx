import { useEffect, useState, type CSSProperties } from 'react';
import { fetchWorkflow } from '../api/workflows';
import WorkflowDetail from './WorkflowDetail';
import ViewCodeModal from './ViewCodeModal';
import type { WorkflowRun } from '@dynflow/shared';

interface WorkflowDrawerProps {
  workflowId: string;
  onClose: () => void;
  onError?: (msg: string) => void;
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.4)',
  zIndex: 1000,
};

const DRAWER_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: '50vw',
  minWidth: 600,
  maxWidth: 900,
  backgroundColor: '#fff',
  boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
  zIndex: 1001,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '16px 20px',
  borderBottom: '1px solid #e5e7eb',
  backgroundColor: '#f9fafb',
  flexShrink: 0,
};

const CONTENT_STYLE: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px',
};

export default function WorkflowDrawer({ workflowId, onClose, onError }: WorkflowDrawerProps) {
  const [workflow, setWorkflow] = useState<WorkflowRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWorkflow(workflowId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setWorkflow(res.data);
        } else {
          onError?.(res.error || 'Failed to load workflow');
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          onError?.(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, onError]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <>
      {/* Overlay backdrop */}
      <div style={OVERLAY_STYLE} onClick={handleOverlayClick} />

      {/* Drawer panel */}
      <div style={DRAWER_STYLE} role="dialog" aria-label="Workflow details">
        {/* Header */}
        <div style={HEADER_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#1e293b' }}>
              {workflow?.name || 'Loading...'}
            </h2>
            {workflow?.script && (
              <button
                onClick={() => setShowCode(true)}
                style={{
                  padding: '4px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  backgroundColor: '#fff',
                  color: '#374151',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                View Code
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
              color: '#6b7280',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={CONTENT_STYLE}>
          {loading ? (
            <div style={{ color: '#6b7280', fontStyle: 'italic' }}>Loading...</div>
          ) : workflow ? (
            <WorkflowDetail workflowId={workflowId} />
          ) : (
            <div style={{ color: '#dc2626' }}>Failed to load workflow details.</div>
          )}
        </div>
      </div>

      {/* View Code Modal (conditionally rendered) */}
      {showCode && workflow?.script && (
        <ViewCodeModal
          script={workflow.script}
          workflowName={workflow.name}
          onClose={() => setShowCode(false)}
        />
      )}
    </>
  );
}
