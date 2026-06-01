import { useEffect } from 'react';

interface ToastProps {
  message: string;
  type: 'error' | 'info' | 'success';
  onClose: () => void;
  durationMs?: number;
}

const COLORS: Record<ToastProps['type'], { bg: string; text: string; border: string }> = {
  error: { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' },
  info: { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' },
  success: { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0' },
};

export default function Toast({
  message,
  type,
  onClose,
  durationMs = 5000,
}: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, durationMs);
    return () => clearTimeout(timer);
  }, [onClose, durationMs]);

  const colors = COLORS[type];

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        padding: '12px 16px',
        borderRadius: '8px',
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        fontSize: '0.875rem',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        maxWidth: '400px',
      }}
      role="alert"
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={onClose}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: colors.text,
          fontSize: '1.25rem',
          lineHeight: 1,
          padding: '0 4px',
        }}
        aria-label="Close"
      >
        &times;
      </button>
    </div>
  );
}
