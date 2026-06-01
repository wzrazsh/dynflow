import { useState, useRef, type KeyboardEvent } from 'react';

export interface TagPickerProps {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
}

// Reusable inline styles
const styles = {
  container: {
    border: '1px solid #d1d5db',
    borderRadius: 8,
    overflow: 'hidden' as const,
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    backgroundColor: '#f9fafb',
  },
  headerTitle: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 700,
    color: '#1f2937',
  },
  tagArea: {
    display: 'flex' as const,
    flexWrap: 'wrap' as const,
    gap: 6,
    padding: '10px 12px',
    minHeight: 42,
    alignItems: 'center',
  },
  chip: {
    display: 'inline-flex' as const,
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    backgroundColor: '#dbeafe',
    color: '#1e40af',
    borderRadius: 4,
    fontSize: '0.8125rem',
    fontWeight: 500,
    lineHeight: '1.4',
    maxWidth: 200,
  },
  chipLabel: {
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  removeButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#1e40af',
    fontSize: '1rem',
    lineHeight: 1,
    padding: 0,
    display: 'inline-flex' as const,
    alignItems: 'center',
    opacity: 0.6,
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minWidth: 120,
    border: 'none',
    outline: 'none',
    fontSize: '0.875rem',
    padding: '2px 0',
    color: '#1f2937',
    background: 'transparent',
  },
  emptyHint: {
    color: '#9ca3af',
    fontSize: '0.875rem',
    userSelect: 'none' as const,
  },
};

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={styles.chip}>
      <span style={styles.chipLabel}>{label}</span>
      <button
        onClick={onRemove}
        style={styles.removeButton}
        aria-label={`Remove ${label}`}
      >
        &times;
      </button>
    </span>
  );
}

export default function TagPicker({ selectedTags, onChange }: TagPickerProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedSet = new Set(selectedTags);

  function addTags(raw: string) {
    const newTags = raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !selectedSet.has(t));

    if (newTags.length === 0) return;

    // Build a combined set so comma-separated input doesn't allow duplicates
    // within the same batch either
    const combined = [...selectedTags];
    for (const tag of newTags) {
      if (!combined.includes(tag)) {
        combined.push(tag);
      }
    }
    onChange(combined);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (inputValue.trim()) {
        addTags(inputValue);
        setInputValue('');
      }
    } else if (e.key === 'Backspace' && inputValue.length === 0 && selectedTags.length > 0) {
      // Remove last tag on backspace when input is empty
      onChange(selectedTags.slice(0, -1));
    }
  }

  function handleChange(value: string) {
    // If the value contains a comma, split and add tags immediately
    if (value.includes(',')) {
      const beforeComma = value.slice(0, value.lastIndexOf(','));
      if (beforeComma.trim()) {
        addTags(beforeComma);
      }
      // Keep everything after the last comma as the current input value
      const afterComma = value.slice(value.lastIndexOf(',') + 1);
      setInputValue(afterComma);
    } else {
      setInputValue(value);
    }
  }

  function handleRemoveTag(tag: string) {
    onChange(selectedTags.filter((t) => t !== tag));
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.headerTitle}>Tags</h3>
      </div>
      <div
        style={styles.tagArea}
        onClick={() => inputRef.current?.focus()}
      >
        {selectedTags.map((tag) => (
          <Chip key={tag} label={tag} onRemove={() => handleRemoveTag(tag)} />
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={selectedTags.length === 0 ? 'Add a tag...' : ''}
          style={inputValue || selectedTags.length > 0 ? styles.input : { ...styles.input, ...styles.emptyHint } as React.CSSProperties}
          aria-label="Add a tag"
        />
      </div>
    </div>
  );
}
