import { useEffect, useState, useMemo } from 'react';
import { get } from '../api/client.js';
import type { WorkflowTemplate, ApiResponse } from '@dynflow/shared';

interface TemplateListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onError?: (message: string) => void;
}

export default function TemplateList({ selectedId, onSelect, onError }: TemplateListProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await get<ApiResponse<WorkflowTemplate[]>>('/templates');
      setTemplates(res.data ?? []);
      setError(null);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      onError?.(`Failed to load templates: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    templates.forEach((t) => t.tags.forEach((tag) => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchesSearch =
        search === '' ||
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.description?.toLowerCase().includes(search.toLowerCase()) ?? false);
      const matchesTag = activeTag === null || t.tags.includes(activeTag);
      return matchesSearch && matchesTag;
    });
  }, [templates, search, activeTag]);

  const styles: Record<string, React.CSSProperties> = {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    },
    searchInput: {
      padding: '8px 12px',
      border: '1px solid #ddd',
      borderRadius: '4px',
      fontSize: '0.9rem',
      marginBottom: '8px',
      outline: 'none',
    },
    tagContainer: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px',
      marginBottom: '12px',
    },
    tagChip: {
      padding: '2px 8px',
      borderRadius: '12px',
      fontSize: '0.75rem',
      cursor: 'pointer',
      border: '1px solid #ccc',
      background: '#fff',
      color: '#555',
    },
    tagChipActive: {
      background: '#e3f2fd',
      borderColor: '#1976d2',
      color: '#1976d2',
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      overflowY: 'auto',
      flex: 1,
    },
    item: {
      cursor: 'pointer',
      padding: '10px',
      border: '1px solid #e0e0e0',
      borderRadius: '6px',
    },
    itemSelected: {
      background: '#e8f0fe',
      borderColor: '#1976d2',
    },
    itemName: {
      fontWeight: 600,
      fontSize: '0.95rem',
      marginBottom: '2px',
      color: '#222',
    },
    itemDescription: {
      fontSize: '0.8rem',
      color: '#666',
      marginBottom: '4px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    itemMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    },
    versionBadge: {
      fontSize: '0.7rem',
      padding: '1px 6px',
      borderRadius: '10px',
      background: '#f0f0f0',
      color: '#555',
    },
    itemTags: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '3px',
      marginTop: '4px',
    },
    itemTag: {
      fontSize: '0.7rem',
      padding: '1px 6px',
      borderRadius: '8px',
      background: '#f5f5f5',
      color: '#888',
    },
    stateMessage: {
      padding: '20px',
      textAlign: 'center' as const,
      color: '#888',
      fontSize: '0.9rem',
    },
    errorMessage: {
      padding: '20px',
      textAlign: 'center' as const,
      color: '#d32f2f',
      fontSize: '0.9rem',
    },
  };

  if (loading) {
    return <div style={styles.stateMessage}>Loading templates...</div>;
  }

  if (error) {
    return <div style={styles.errorMessage}>Error: {error}</div>;
  }

  return (
    <div style={styles.container}>
      <input
        style={styles.searchInput}
        placeholder="Search templates..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {allTags.length > 0 && (
        <div style={styles.tagContainer}>
          <span
            style={{
              ...styles.tagChip,
              ...(activeTag === null ? styles.tagChipActive : {}),
            }}
            onClick={() => setActiveTag(null)}
          >
            All
          </span>
          {allTags.map((tag) => (
            <span
              key={tag}
              style={{
                ...styles.tagChip,
                ...(activeTag === tag ? styles.tagChipActive : {}),
              }}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div style={styles.list}>
        {filteredTemplates.length === 0 ? (
          <div style={styles.stateMessage}>No templates found</div>
        ) : (
          filteredTemplates.map((t) => (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              style={{
                ...styles.item,
                ...(selectedId === t.id ? styles.itemSelected : {}),
              }}
            >
              <div style={styles.itemName}>{t.name}</div>
              {t.description && (
                <div style={styles.itemDescription}>{t.description}</div>
              )}
              <div style={styles.itemMeta}>
                <span style={styles.versionBadge}>v{t.currentVersion}</span>
              </div>
              {t.tags.length > 0 && (
                <div style={styles.itemTags}>
                  {t.tags.map((tag) => (
                    <span key={tag} style={styles.itemTag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
