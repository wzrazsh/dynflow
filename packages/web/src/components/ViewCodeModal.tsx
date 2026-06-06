import { useEffect, type CSSProperties } from 'react';

interface ViewCodeModalProps {
  script: string;
  workflowName: string;
  onClose: () => void;
}

const OVERLAY_STYLE: CSSProperties = {
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

const MODAL_STYLE: CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: 8,
  padding: 24,
  maxWidth: 700,
  width: '90%',
  maxHeight: '90vh',
  overflowY: 'auto',
  position: 'relative',
};

export default function ViewCodeModal({ script, workflowName, onClose }: ViewCodeModalProps) {
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

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(script);
    } catch {
      // Clipboard API not available
    }
  }

  return (
    <div style={OVERLAY_STYLE} onClick={handleOverlayClick}>
      <div style={MODAL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            Workflow Code: {workflowName}
          </h2>
        </div>

        <textarea
          readOnly
          value={script}
          rows={20}
          style={{
            width: '100%',
            padding: '12px',
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: '0.8125rem',
            lineHeight: 1.5,
            border: '1px solid #d1d5db',
            borderRadius: 4,
            backgroundColor: '#f9fafb',
            color: '#374151',
            resize: 'vertical',
            boxSizing: 'border-box',
            tabSize: 2,
          }}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={handleCopy}
            style={{
              padding: '8px 16px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              backgroundColor: '#fff',
              color: '#374151',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 600,
            }}
          >
            Copy
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              backgroundColor: '#3b82f6',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
