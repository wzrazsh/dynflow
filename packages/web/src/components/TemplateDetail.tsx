import { useState, useEffect, useCallback } from 'react';
import { get } from '../api/client.js';
import type { WorkflowTemplate, ApiResponse } from '@dynflow/shared';

interface TemplateDetailProps {
  templateId: string;
  onBack: () => void;
  onEdit?: (template: WorkflowTemplate) => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

const TAG_COLORS: Record<string, string> = {
  analysis: '#7c3aed',
  automation: '#2563eb',
  data: '#0891b2',
  default: '#6b7280',
  devops: '#059669',
  frontend: '#d97706',
  integration: '#9333ea',
  monitoring: '#0284c7',
  security: '#dc2626',
  testing: '#ca8a04',
};

function getTagColor(tag: string): string {
  const key = tag.toLowerCase().replace(/\s+/g, '');
  return TAG_COLORS[key] || TAG_COLORS.default;
}

export default function TemplateDetail({
  templateId,
  onBack,
  onEdit,
  onError,
  onSuccess,
}: TemplateDetailProps) {
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadTemplate = useCallback(async () => {
    try {
      setLoading(true);
      const res = await get<ApiResponse<WorkflowTemplate>>(
        `/api/templates/${templateId}`,
      );
      if (res.success && res.data) {
        setTemplate(res.data);
        setError(null);
      } else {
        const msg = res.error || 'Template not found';
        setError(msg);
        onError?.(msg);
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      onError?.(`Failed to load template: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [templateId, onError]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function handleExport() {
    if (!template) return;
    setExporting(true);
    try {
      const blob = new Blob([template.script], {
        type: 'application/javascript',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${template.name.replace(/\s+/g, '_')}.js`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onSuccess?.('Template exported successfully');
    } catch {
      onError?.('Failed to export template');
    } finally {
      setExporting(false);
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    container: {
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    },
    backButton: {
      background: 'none',
      border: 'none',
      color: '#3b82f6',
      cursor: 'pointer',
      padding: 0,
      fontSize: '0.875rem',
      textAlign: 'left' as const,
      width: 'fit-content' as const,
    },
    header: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '12px',
      flexWrap: 'wrap' as const,
    },
    titleRow: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      flexWrap: 'wrap' as const,
    },
    name: {
      margin: 0,
      fontSize: '1.25rem',
      fontWeight: 600,
      color: '#1f2937',
    },
    versionBadge: {
      fontSize: '0.75rem',
      padding: '2px 8px',
      borderRadius: '10px',
      background: '#e5e7eb',
      color: '#374151',
      fontWeight: 600,
    },
    description: {
      margin: 0,
      color: '#6b7280',
      fontSize: '0.875rem',
      lineHeight: 1.5,
    },
    metaRow: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      fontSize: '0.8125rem',
      color: '#9ca3af',
    },
    tagsContainer: {
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: '6px',
    },
    tagPill: {
      padding: '2px 10px',
      borderRadius: '12px',
      fontSize: '0.75rem',
      fontWeight: 600,
      color: '#fff',
      display: 'inline-block',
      lineHeight: '1.6',
    },
    sectionLabel: {
      fontSize: '0.8125rem',
      fontWeight: 600,
      color: '#374151',
      marginBottom: '6px',
    },
    scriptBlock: {
      margin: 0,
      padding: '12px 14px',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
      borderRadius: 6,
      fontSize: '0.8125rem',
      fontFamily: "'Courier New', Courier, monospace",
      overflowX: 'auto' as const,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-word' as const,
      lineHeight: 1.5,
      maxHeight: '400px',
      overflowY: 'auto' as const,
      color: '#1f2937',
    },
    actions: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap' as const,
    },
    primaryButton: {
      padding: '8px 20px',
      backgroundColor: '#1976d2',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      fontSize: '0.875rem',
      fontWeight: 600,
      cursor: 'pointer',
    },
    secondaryButton: {
      padding: '8px 20px',
      backgroundColor: '#fff',
      color: '#374151',
      border: '1px solid #d1d5db',
      borderRadius: 6,
      fontSize: '0.875rem',
      fontWeight: 600,
      cursor: 'pointer',
    },
    stateMessage: {
      padding: '20px',
      textAlign: 'center' as const,
      color: '#6b7280',
      fontSize: '0.9rem',
    },
    errorBox: {
      padding: '8px 12px',
      backgroundColor: '#fee2e2',
      color: '#991b1b',
      borderRadius: 6,
      fontSize: '0.875rem',
    },
  };

  // Loading state
  if (loading) {
    return (
      <div>
        <button onClick={onBack} style={styles.backButton}>
          &larr; Back to templates
        </button>
        <div style={styles.stateMessage}>Loading template...</div>
      </div>
    );
  }

  // Error state (not found or fetch error)
  if (error) {
    return (
      <div>
        <button onClick={onBack} style={styles.backButton}>
          &larr; Back to templates
        </button>
        <div style={styles.errorBox}>{error}</div>
      </div>
    );
  }

  // Null guard
  if (!template) {
    return (
      <div>
        <button onClick={onBack} style={styles.backButton}>
          &larr; Back to templates
        </button>
        <div style={styles.stateMessage}>Template not found</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Back button */}
      <button onClick={onBack} style={styles.backButton}>
        &larr; Back to templates
      </button>

      {/* Name + version */}
      <div style={styles.titleRow}>
        <h2 style={styles.name}>{template.name}</h2>
        <span style={styles.versionBadge}>v{template.currentVersion}</span>
      </div>

      {/* Description */}
      {template.description && (
        <p style={styles.description}>{template.description}</p>
      )}

      {/* Meta info */}
      <div style={styles.metaRow}>
        <span>Created: {formatTime(template.createdAt)}</span>
        <span>Updated: {formatTime(template.updatedAt)}</span>
      </div>

      {/* Tags */}
      {template.tags.length > 0 && (
        <div>
          <div style={styles.sectionLabel}>Tags</div>
          <div style={styles.tagsContainer}>
            {template.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  ...styles.tagPill,
                  backgroundColor: getTagColor(tag),
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Script */}
      <div>
        <div style={styles.sectionLabel}>Script</div>
        <pre style={styles.scriptBlock}>{template.script}</pre>
      </div>

      {/* Action buttons */}
      <div style={styles.actions}>
        <button
          style={styles.primaryButton}
          onClick={() => onSuccess?.('Run template: ' + template.name)}
        >
          Run
        </button>
        <button
          style={styles.secondaryButton}
          onClick={() => onEdit?.(template)}
        >
          Edit
        </button>
        <button
          style={styles.secondaryButton}
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? 'Exporting...' : 'Export'}
        </button>
      </div>
    </div>
  );
}
