import { useEffect, useState, useCallback, useRef } from 'react';
import type { Skill, AgentSource, SkillCategory } from '@dynflow/shared';
import { fetchSkills, fetchAgentSources } from '../api/skills';

export interface SkillPickerProps {
  selectedSkills: string[];
  onSelectionChange: (skillIds: string[]) => void;
  sourceFilter?: string;
  categoryFilter?: string;
  maxSelections?: number;
}

const ALL_CATEGORIES: SkillCategory[] = [
  'development',
  'analysis',
  'research',
  'creative',
  'communication',
  'automation',
  'other',
];

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  development: 'Development',
  analysis: 'Analysis',
  research: 'Research',
  creative: 'Creative',
  communication: 'Communication',
  automation: 'Automation',
  other: 'Other',
};

const CATEGORY_COLORS: Record<SkillCategory, { bg: string; text: string }> = {
  development: { bg: '#dbeafe', text: '#1e40af' },
  analysis: { bg: '#e0e7ff', text: '#3730a3' },
  research: { bg: '#f3e8ff', text: '#6b21a8' },
  creative: { bg: '#fce7f3', text: '#9d174d' },
  communication: { bg: '#d1fae5', text: '#065f46' },
  automation: { bg: '#fff3cd', text: '#856404' },
  other: { bg: '#f3f4f6', text: '#374151' },
};

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
    fontSize: '1rem',
    fontWeight: 600,
    color: '#111827',
  },
  filters: {
    display: 'flex' as const,
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    flexWrap: 'wrap' as const,
  },
  input: {
    flex: 1,
    minWidth: 160,
    padding: '6px 10px',
    fontSize: '0.8125rem',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    outline: 'none',
  },
  select: {
    padding: '6px 10px',
    fontSize: '0.8125rem',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    backgroundColor: '#fff',
    outline: 'none',
    cursor: 'pointer',
  },
  list: {
    maxHeight: 320,
    overflowY: 'auto' as const,
    padding: 0,
    margin: 0,
    listStyle: 'none',
  },
  listItem: {
    display: 'flex' as const,
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 16px',
    borderBottom: '1px solid #f3f4f6',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  checkbox: {
    marginTop: 2,
    cursor: 'pointer',
    accentColor: '#3b82f6',
  },
  skillInfo: {
    flex: 1,
    minWidth: 0,
  },
  skillName: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#111827',
    marginBottom: 2,
  },
  skillDescription: {
    fontSize: '0.75rem',
    color: '#6b7280',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    marginBottom: 4,
  },
  skillMeta: {
    display: 'flex' as const,
    gap: 6,
    alignItems: 'center',
  },
  categoryBadge: {
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: '0.6875rem',
    fontWeight: 600,
  },
  paramCount: {
    fontSize: '0.6875rem',
    color: '#9ca3af',
  },
  footer: {
    display: 'flex' as const,
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    backgroundColor: '#f9fafb',
    borderTop: '1px solid #e5e7eb',
  },
  countText: {
    fontSize: '0.8125rem',
    color: '#6b7280',
  },
  clearButton: {
    fontSize: '0.8125rem',
    color: '#3b82f6',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 8px',
    borderRadius: 4,
  },
  loadingRow: {
    padding: '24px 16px',
    textAlign: 'center' as const,
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  errorRow: {
    padding: '24px 16px',
    textAlign: 'center' as const,
    fontSize: '0.875rem',
    color: '#dc2626',
  },
  emptyRow: {
    padding: '24px 16px',
    textAlign: 'center' as const,
    fontSize: '0.875rem',
    color: '#9ca3af',
  },
};

export default function SkillPicker({
  selectedSkills,
  onSelectionChange,
  sourceFilter: externalSourceFilter,
  categoryFilter: externalCategoryFilter,
  maxSelections = 20,
}: SkillPickerProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [localSource, setLocalSource] = useState('');
  const [localCategory, setLocalCategory] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Effective filters: external props override local state
  const effectiveSource = externalSourceFilter ?? localSource;
  const effectiveCategory = externalCategoryFilter ?? localCategory;

  // Debounce search input
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // Fetch agent sources once
  useEffect(() => {
    fetchAgentSources()
      .then((res) => {
        if (res.success && res.data) setSources(res.data);
      })
      .catch(() => {
        // Non-blocking - source filter just won't be populated
      });
  }, []);

  // Fetch skills whenever filters change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSkills({
      sourceId: effectiveSource || undefined,
      category: effectiveCategory || undefined,
      search: debouncedSearch || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setSkills(res.data);
        } else {
          setError(res.error ?? 'Failed to load skills');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveSource, effectiveCategory, debouncedSearch]);

  const handleToggle = useCallback(
    (skillId: string) => {
      if (selectedSkills.includes(skillId)) {
        onSelectionChange(selectedSkills.filter((id) => id !== skillId));
      } else if (selectedSkills.length < maxSelections) {
        onSelectionChange([...selectedSkills, skillId]);
      }
    },
    [selectedSkills, onSelectionChange, maxSelections],
  );

  const handleClearAll = useCallback(() => {
    onSelectionChange([]);
  }, [onSelectionChange]);

  const canSelectMore = selectedSkills.length < maxSelections;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.headerTitle}>Select Skills</h3>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <input
          type="text"
          placeholder="Search skills..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          style={styles.input}
          aria-label="Search skills"
        />
        {!externalSourceFilter && (
          <select
            value={localSource}
            onChange={(e) => setLocalSource(e.target.value)}
            style={styles.select}
            aria-label="Filter by source"
          >
            <option value="">All Sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {!externalCategoryFilter && (
          <select
            value={localCategory}
            onChange={(e) => setLocalCategory(e.target.value)}
            style={styles.select}
            aria-label="Filter by category"
          >
            <option value="">All Categories</option>
            {ALL_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div style={styles.loadingRow}>Loading skills...</div>
      ) : error ? (
        <div style={styles.errorRow}>Error: {error}</div>
      ) : skills.length === 0 ? (
        <div style={styles.emptyRow}>No skills found</div>
      ) : (
        <ul style={styles.list}>
          {skills.map((skill) => {
            const isSelected = selectedSkills.includes(skill.id);
            const categoryColor = CATEGORY_COLORS[skill.category] ?? CATEGORY_COLORS.other;
            return (
              <li
                key={skill.id}
                style={{
                  ...styles.listItem,
                  backgroundColor: isSelected ? '#eff6ff' : undefined,
                  opacity: !isSelected && !canSelectMore ? 0.5 : 1,
                }}
                onClick={() => {
                  if (!isSelected && !canSelectMore) return;
                  handleToggle(skill.id);
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = isSelected ? '#dbeafe' : '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = isSelected ? '#eff6ff' : '';
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggle(skill.id)}
                  style={styles.checkbox}
                  disabled={!isSelected && !canSelectMore}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${skill.name}`}
                />
                <div style={styles.skillInfo}>
                  <div style={styles.skillName}>{skill.name}</div>
                  <div style={styles.skillDescription} title={skill.description}>
                    {skill.description}
                  </div>
                  <div style={styles.skillMeta}>
                    <span
                      style={{
                        ...styles.categoryBadge,
                        backgroundColor: categoryColor.bg,
                        color: categoryColor.text,
                      }}
                    >
                      {CATEGORY_LABELS[skill.category] ?? skill.category}
                    </span>
                    <span style={styles.paramCount}>
                      {skill.parameters.length} parameter{skill.parameters.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Footer */}
      <div style={styles.footer}>
        <span style={styles.countText}>
          {selectedSkills.length} skill{selectedSkills.length !== 1 ? 's' : ''} selected
          {!canSelectMore && selectedSkills.length > 0
            ? ` (max ${maxSelections})`
            : ''}
        </span>
        {selectedSkills.length > 0 && (
          <button onClick={handleClearAll} style={styles.clearButton}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
