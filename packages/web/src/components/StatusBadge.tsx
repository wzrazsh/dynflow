const COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: '#e5e7eb', text: '#374151' },
  running: { bg: '#dbeafe', text: '#1e40af' },
  paused: { bg: '#fef3c7', text: '#92400e' },
  completed: { bg: '#d1fae5', text: '#065f46' },
  failed: { bg: '#fee2e2', text: '#991b1b' },
  stopped: { bg: '#ffedd5', text: '#9a3412' },
  interrupted: { bg: '#ede9fe', text: '#5b21b6' },
};

export default function StatusBadge({ status }: { status: string }) {
  const colors = COLORS[status] || COLORS.pending;
  return (
    <span
      style={{
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: colors.bg,
        color: colors.text,
        display: 'inline-block',
        lineHeight: '1.5',
      }}
    >
      {status}
    </span>
  );
}
