import { useState, useEffect, useCallback } from 'react';
import type { RuntimeConfig, SystemInfo } from '@dynflow/shared';
import RuntimeConfigForm from './RuntimeConfigForm';

interface StartRunDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (runtimeConfig: RuntimeConfig) => Promise<void>;
  defaultRuntimeConfig?: RuntimeConfig;
  systemInfo: SystemInfo | null;
  workflowName: string;
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100,
};

const MODAL_STYLE: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: 8,
  padding: 24,
  maxWidth: 500,
  width: '90%',
  position: 'relative',
};

export default function StartRunDialog({
  open,
  onClose,
  onConfirm,
  defaultRuntimeConfig,
  systemInfo,
  workflowName,
}: StartRunDialogProps) {
  const [config, setConfig] = useState<RuntimeConfig>(defaultRuntimeConfig ?? {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset config when dialog opens
  useEffect(() => {
    if (open) {
      setConfig(defaultRuntimeConfig ?? {});
      setError(null);
      setLoading(false);
    }
  }, [open, defaultRuntimeConfig]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleStart = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm(config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [config, onConfirm, onClose]);

  if (!open) return null;

  return (
    <div style={OVERLAY_STYLE} onClick={handleOverlayClick}>
      <div style={MODAL_STYLE}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            Start: {workflowName}
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: '#6b7280', padding: 0, lineHeight: 1 }}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Runtime config form */}
        <RuntimeConfigForm
          value={config}
          onChange={setConfig}
          systemInfo={systemInfo}
        />

        {/* Error */}
        {error && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              backgroundColor: '#fee2e2',
              color: '#991b1b',
              borderRadius: 4,
              fontSize: '0.8125rem',
            }}
          >
            {error}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '8px 16px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              backgroundColor: '#fff',
              color: '#374151',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 600,
              opacity: loading ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={loading}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: 6,
              backgroundColor: loading ? '#93c5fd' : '#3b82f6',
              color: '#fff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 600,
            }}
          >
            {loading ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
