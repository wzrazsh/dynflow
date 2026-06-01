import { useState, useEffect, useCallback } from 'react';
import { get } from '../api/client.js';
import type { WorkflowTemplateVersion, ApiResponse } from '@dynflow/shared';

interface TemplateVersionHistoryProps {
  templateId: string;
  currentVersion: number;
  onVersionSelect: (version: number) => void;
  onRollback: (version: number) => void;
}

interface DiffResult {
  from: { version: number; name: string };
  to: { version: number; name: string };
  added: string[];
  removed: string[];
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  title: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#1f2937',
    margin: 0,
  },
  compareSection: {
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '12px',
    backgroundColor: '#fafafa',
  },
  compareHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap' as const,
    marginBottom: '8px',
  },
  compareLabel: {
    fontSize: '0.8125rem',
    color: '#374151',
    fontWeight: 500,
  },
  select: {
    padding: '4px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: '0.8125rem',
    color: '#1f2937',
    backgroundColor: '#fff',
    outline: 'none',
    minWidth: '100px',
  },
  compareButton: {
    padding: '4px 14px',
    backgroundColor: '#1976d2',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontSize: '0.8125rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  compareButtonDisabled: {
    padding: '4px 14px',
    backgroundColor: '#9fc5e8',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontSize: '0.8125rem',
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  diffContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: '8px',
  },
  diffSection: {
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  diffHeader: {
    fontSize: '0.75rem',
    fontWeight: 600,
    padding: '4px 10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  diffAddedHeader: {
    backgroundColor: '#bbf7d0',
    color: '#166534',
  },
  diffRemovedHeader: {
    backgroundColor: '#fecaca',
    color: '#991b1b',
  },
  diffList: {
    margin: 0,
    padding: '6px 10px',
    listStyle: 'none',
    maxHeight: '200px',
    overflowY: 'auto' as const,
    fontSize: '0.8125rem',
    fontFamily: "'Courier New', Courier, monospace",
    lineHeight: 1.5,
  },
  diffAddedList: {
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderTop: 'none',
  },
  diffRemovedList: {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderTop: 'none',
  },
  diffLine: {
    padding: '1px 0',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  diffAddedLine: {
    color: '#166534',
  },
  diffRemovedLine: {
    color: '#991b1b',
  },
  diffEmpty: {
    color: '#9ca3af',
    fontSize: '0.8125rem',
    padding: '4px 10px',
    fontStyle: 'italic',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  versionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  versionItemHover: {
    borderColor: '#1976d2',
  },
  versionInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  versionNumberBadge: {
    fontSize: '0.75rem',
    padding: '2px 8px',
    borderRadius: 10,
    backgroundColor: '#e5e7eb',
    color: '#374151',
    fontWeight: 600,
    flexShrink: 0,
  },
  versionName: {
    fontSize: '0.875rem',
    color: '#1f2937',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  versionMeta: {
    fontSize: '0.75rem',
    color: '#9ca3af',
  },
  currentBadge: {
    fontSize: '0.7rem',
    padding: '2px 8px',
    borderRadius: 10,
    backgroundColor: '#d1fae5',
    color: '#065f46',
    fontWeight: 600,
    flexShrink: 0,
  },
  rollbackButton: {
    padding: '4px 12px',
    backgroundColor: '#fff',
    color: '#d97706',
    border: '1px solid #fcd34d',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  rollbackButtonDisabled: {
    padding: '4px 12px',
    backgroundColor: '#f5f5f5',
    color: '#9ca3af',
    border: '1px solid #e5e7eb',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'not-allowed',
    flexShrink: 0,
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
  rollbackingBadge: {
    fontSize: '0.7rem',
    padding: '2px 8px',
    borderRadius: 10,
    backgroundColor: '#fef3c7',
    color: '#92400e',
    fontWeight: 600,
    flexShrink: 0,
  },
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function TemplateVersionHistory({
  templateId,
  currentVersion,
  onVersionSelect,
  onRollback,
}: TemplateVersionHistoryProps) {
  const [versions, setVersions] = useState<WorkflowTemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rollbackingVersion, setRollbackingVersion] = useState<number | null>(null);

  // Compare state
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      setLoading(true);
      const res = await get<ApiResponse<WorkflowTemplateVersion[]>>(
        `/templates/${templateId}/versions`,
      );
      if (res.success && res.data) {
        setVersions(res.data);
        setError(null);
      } else {
        setError(res.error || 'Failed to load versions');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  async function handleCompare() {
    if (compareFrom === null || compareTo === null) return;
    setDiffLoading(true);
    setDiffError(null);
    setDiffResult(null);
    try {
      const res = await get<ApiResponse<DiffResult>>(
        `/templates/${templateId}/versions/compare?from=${compareFrom}&to=${compareTo}`,
      );
      if (res.success && res.data) {
        setDiffResult(res.data);
      } else {
        setDiffError(res.error || 'Failed to compare versions');
      }
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setDiffLoading(false);
    }
  }

  function handleSelectVersion(version: number) {
    onVersionSelect(version);
  }

  async function handleRollback(version: number) {
    setRollbackingVersion(version);
    try {
      await onRollback(version);
    } finally {
      setRollbackingVersion(null);
    }
  }

  // Loading state
  if (loading) {
    return (
      <div style={styles.container}>
        <h3 style={styles.title}>Version History</h3>
        <div style={styles.stateMessage}>Loading version history...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.container}>
        <h3 style={styles.title}>Version History</h3>
        <div style={styles.errorBox}>{error}</div>
      </div>
    );
  }

  // Empty state
  if (versions.length === 0) {
    return (
      <div style={styles.container}>
        <h3 style={styles.title}>Version History</h3>
        <div style={styles.stateMessage}>No version history available</div>
      </div>
    );
  }

  const canCompare = compareFrom !== null && compareTo !== null && compareFrom !== compareTo;

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>Version History</h3>

      {/* Compare Versions Section */}
      <div style={styles.compareSection}>
        <div style={styles.compareHeader}>
          <span style={styles.compareLabel}>Compare:</span>
          <select
            style={styles.select}
            value={compareFrom ?? ''}
            onChange={(e) => {
              const val = e.target.value ? Number(e.target.value) : null;
              setCompareFrom(val);
              setDiffResult(null);
              setDiffError(null);
            }}
          >
            <option value="">From version</option>
            {versions.map((v) => (
              <option key={`from-${v.version}`} value={v.version}>
                v{v.version} — {v.name}
              </option>
            ))}
          </select>
          <span style={styles.compareLabel}>to</span>
          <select
            style={styles.select}
            value={compareTo ?? ''}
            onChange={(e) => {
              const val = e.target.value ? Number(e.target.value) : null;
              setCompareTo(val);
              setDiffResult(null);
              setDiffError(null);
            }}
          >
            <option value="">To version</option>
            {versions.map((v) => (
              <option key={`to-${v.version}`} value={v.version}>
                v{v.version} — {v.name}
              </option>
            ))}
          </select>
          <button
            style={canCompare ? styles.compareButton : styles.compareButtonDisabled}
            disabled={!canCompare}
            onClick={handleCompare}
          >
            {diffLoading ? 'Comparing...' : 'Compare'}
          </button>
        </div>

        {/* Diff error */}
        {diffError && <div style={styles.errorBox}>{diffError}</div>}

        {/* Diff result */}
        {diffResult && (
          <div style={styles.diffContainer}>
            <div style={styles.diffSection}>
              <div style={{ ...styles.diffHeader, ...styles.diffAddedHeader }}>
                Added ({diffResult.added.length} line{diffResult.added.length !== 1 ? 's' : ''})
              </div>
              <div style={{ ...styles.diffList, ...styles.diffAddedList }}>
                {diffResult.added.length === 0 ? (
                  <div style={styles.diffEmpty}>No lines added</div>
                ) : (
                  diffResult.added.map((line, i) => (
                    <div
                      key={i}
                      style={{ ...styles.diffLine, ...styles.diffAddedLine }}
                    >
                      + {line}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div style={styles.diffSection}>
              <div style={{ ...styles.diffHeader, ...styles.diffRemovedHeader }}>
                Removed ({diffResult.removed.length} line{diffResult.removed.length !== 1 ? 's' : ''})
              </div>
              <div style={{ ...styles.diffList, ...styles.diffRemovedList }}>
                {diffResult.removed.length === 0 ? (
                  <div style={styles.diffEmpty}>No lines removed</div>
                ) : (
                  diffResult.removed.map((line, i) => (
                    <div
                      key={i}
                      style={{ ...styles.diffLine, ...styles.diffRemovedLine }}
                    >
                      - {line}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Version List */}
      <div style={styles.list}>
        {versions.map((v) => {
          const isCurrent = v.version === currentVersion;
          const isRollbacking = rollbackingVersion === v.version;

          return (
            <div
              key={v.id}
              style={styles.versionItem}
              onClick={() => handleSelectVersion(v.version)}
            >
              <span style={styles.versionNumberBadge}>v{v.version}</span>
              <div style={styles.versionInfo}>
                <div style={styles.versionName}>{v.name}</div>
                <div style={styles.versionMeta}>{formatTime(v.createdAt)}</div>
              </div>
              {isCurrent ? (
                <span style={styles.currentBadge}>Current</span>
              ) : isRollbacking ? (
                <span style={styles.rollbackingBadge}>Rolling back...</span>
              ) : (
                <button
                  style={styles.rollbackButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRollback(v.version);
                  }}
                >
                  Rollback
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
