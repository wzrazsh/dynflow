import type { RuntimeConfig, SystemInfo } from '@dynflow/shared';

interface RuntimeConfigFormProps {
  value: RuntimeConfig;
  onChange: (value: RuntimeConfig) => void;
  systemInfo: SystemInfo | null;
  disabled?: boolean;
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#374151',
};

const selectStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: '4px',
  border: '1px solid #d1d5db',
  fontSize: '0.8125rem',
  minHeight: '32px',
};

const inputStyle: React.CSSProperties = {
  ...selectStyle,
};

export default function RuntimeConfigForm({
  value,
  onChange,
  systemInfo,
  disabled = false,
}: RuntimeConfigFormProps) {
  const availableRunners = systemInfo?.runners?.filter((r) => r.available) ?? [];
  const availableProviders = systemInfo?.providers?.filter((p) => p.available) ?? [];
  const selectedProvider = value.llmProvider ?? '';
  const modelSuggestions = selectedProvider
    ? systemInfo?.models?.[selectedProvider] ?? []
    : [];

  return (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
      {/* Runner dropdown */}
      <div style={{ ...fieldStyle, flex: 1, minWidth: '140px' }}>
        <label htmlFor="runtime-config-runner" style={labelStyle}>
          Runner
        </label>
        <select
          id="runtime-config-runner"
          value={value.runner ?? ''}
          onChange={(e) => onChange({ ...value, runner: e.target.value || undefined })}
          disabled={disabled}
          style={selectStyle}
        >
          <option value="">(default)</option>
          {availableRunners.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {/* Provider dropdown */}
      <div style={{ ...fieldStyle, flex: 1, minWidth: '140px' }}>
        <label htmlFor="runtime-config-provider" style={labelStyle}>
          Provider
        </label>
        <select
          id="runtime-config-provider"
          value={value.llmProvider ?? ''}
          onChange={(e) => onChange({ ...value, llmProvider: e.target.value || undefined })}
          disabled={disabled}
          style={selectStyle}
        >
          <option value="">(default)</option>
          {availableProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Model text input with datalist */}
      <div style={{ ...fieldStyle, flex: 1, minWidth: '140px' }}>
        <label htmlFor="runtime-config-model" style={labelStyle}>
          Model
        </label>
        <input
          id="runtime-config-model"
          type="text"
          value={value.model ?? ''}
          onChange={(e) => onChange({ ...value, model: e.target.value || undefined })}
          disabled={disabled}
          placeholder={modelSuggestions[0] ?? 'Enter model name'}
          list="runtime-config-models"
          style={inputStyle}
        />
        <datalist id="runtime-config-models">
          {modelSuggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
