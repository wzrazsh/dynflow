interface RuntimeConfigChipsProps {
  runner?: string;
  llmProvider?: string;
  model?: string;
  source?: 'default' | 'override' | 'resolved';
}

const SOURCE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  default: { bg: '#e5e7eb', text: '#374151', label: 'Default' },
  override: { bg: '#d1fae5', text: '#065f46', label: 'Override' },
  resolved: { bg: '#dbeafe', text: '#1e40af', label: 'Resolved' },
};

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: '6px',
  fontSize: '0.75rem',
  lineHeight: '1.4',
  minWidth: '70px',
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.65rem',
  textTransform: 'uppercase',
  opacity: 0.7,
  marginBottom: '2px',
};

const valueStyle: React.CSSProperties = {
  fontWeight: 500,
};

export default function RuntimeConfigChips({
  runner,
  llmProvider,
  model,
  source = 'default',
}: RuntimeConfigChipsProps) {
  const colors = SOURCE_COLORS[source] || SOURCE_COLORS.default;

  const chips = [
    { label: 'Runner', value: runner ?? '—' },
    { label: 'Provider', value: llmProvider ?? '—' },
    { label: 'Model', value: model ?? '—' },
  ];

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      {source !== 'default' && (
        <span
          style={{
            ...chipStyle,
            backgroundColor: colors.bg,
            color: colors.text,
          }}
        >
          <span style={labelStyle}>{colors.label}</span>
          <span style={valueStyle}>Config</span>
        </span>
      )}
      {chips.map((chip) => (
        <span
          key={chip.label}
          style={{
            ...chipStyle,
            backgroundColor: colors.bg,
            color: colors.text,
          }}
        >
          <span style={labelStyle}>{chip.label}</span>
          <span style={valueStyle}>{chip.value}</span>
        </span>
      ))}
    </div>
  );
}
