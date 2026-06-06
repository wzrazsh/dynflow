import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { fetchWorkflows } from '../api/workflows';
import { fetchTemplates } from '../api/templates';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import StatusBadge from './StatusBadge';
import type { WorkflowRun, WorkflowListFilters, WorkflowStatus } from '@dynflow/shared';

interface WorkflowListProps {
  onSelect: (id: string) => void;
  onError?: (msg: string) => void;
}

const STATUS_OPTIONS: { label: string; value: string }[] = [
  { label: 'All Statuses', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Running', value: 'running' },
  { label: 'Paused', value: 'paused' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Stopped', value: 'stopped' },
  { label: 'Interrupted', value: 'interrupted' },
];

const TIME_OPTIONS: { label: string; value: string }[] = [
  { label: 'All Time', value: '' },
  { label: 'Today', value: '1' },
  { label: 'Last 7 Days', value: '7' },
  { label: 'Last 30 Days', value: '30' },
];

const INPUT_STYLE: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: '0.8125rem',
  color: '#374151',
  backgroundColor: '#fff',
};

export default function WorkflowList({ onSelect, onError }: WorkflowListProps) {
  const [data, setData] = useState<WorkflowRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState('');
  const [templates, setTemplates] = useState<{ id: string; name: string; workflowCount: number }[]>([]);

  const debouncedName = useDebouncedValue(nameFilter, 300);

  // AbortController ref to cancel stale requests
  const abortRef = useRef<AbortController | null>(null);

  // Load templates for the dropdown
  useEffect(() => {
    fetchTemplates()
      .then((res) => {
        if (res.success) setTemplates(res.data);
      })
      .catch(() => { /* ignore */ });
  }, []);

  // Build filters object from current filter state
  const buildFilters = useCallback((): WorkflowListFilters => {
    const filters: WorkflowListFilters = {};
    if (debouncedName) filters.name = debouncedName;
    if (statusFilter) filters.status = statusFilter as WorkflowStatus;
    if (templateFilter) filters.templateId = templateFilter;
    if (timeFilter) filters.sinceDays = parseInt(timeFilter, 10);
    return filters;
  }, [debouncedName, statusFilter, templateFilter, timeFilter]);

  // Reset page to 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedName, statusFilter, templateFilter, timeFilter]);

  // Main data fetch effect — runs on filter/page change
  useEffect(() => {
    let cancelled = false;

    // Abort any in-flight request from a previous effect run
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    const filters = buildFilters();
    fetchWorkflows(page, pageSize, filters, controller.signal)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setTotal(res.total);
        setError(null);
        // Clamp page to valid range
        const maxPage = Math.max(1, Math.ceil(res.total / pageSize));
        if (page > maxPage) setPage(maxPage);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if ((e as Error)?.name === 'AbortError') return;
        const msg = String(e);
        setError(msg);
        onError?.(`Network error: ${msg}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    };
  }, [debouncedName, statusFilter, templateFilter, timeFilter, page, buildFilters]);

  // 5s auto-refresh — restarts when filters or page change
  useEffect(() => {
    const controller = new AbortController();

    const interval = setInterval(() => {
      const filters = buildFilters();
      fetchWorkflows(page, pageSize, filters, controller.signal)
        .then((res) => {
          setData(res.data);
          setTotal(res.total);
          const maxPage = Math.max(1, Math.ceil(res.total / pageSize));
          if (page > maxPage) setPage(maxPage);
        })
        .catch(() => { /* ignore abort / network errors during auto-refresh */ });
    }, 5000);

    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [debouncedName, statusFilter, templateFilter, timeFilter, page, buildFilters]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = !!(nameFilter || statusFilter || templateFilter || timeFilter);

  function handleClearFilters() {
    setNameFilter('');
    setStatusFilter('');
    setTemplateFilter('');
    setTimeFilter('');
  }

  // --- Render ---
  return (
    <div>
      <h2>Workflows</h2>

      {/* Filter bar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Filter by name..."
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          style={{ ...INPUT_STYLE, width: 180 }}
          aria-label="Filter by name"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ ...INPUT_STYLE, width: 140 }}
          aria-label="Status filter"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={templateFilter}
          onChange={(e) => setTemplateFilter(e.target.value)}
          style={{ ...INPUT_STYLE, width: 160 }}
          aria-label="Template filter"
        >
          <option value="">All Templates</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.workflowCount})
            </option>
          ))}
        </select>
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value)}
          style={{ ...INPUT_STYLE, width: 140 }}
          aria-label="Time period filter"
        >
          {TIME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Data area */}
      {loading && data.length === 0 ? (
        <div>Loading...</div>
      ) : error ? (
        <div style={{ color: 'red' }}>Error: {error}</div>
      ) : data.length === 0 ? (
        <div>
          {hasFilters ? (
            <span>
              No workflows match your filters.{' '}
              <button
                onClick={handleClearFilters}
                style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Clear filters
              </button>
            </span>
          ) : (
            'No workflows yet. Create your first workflow.'
          )}
        </div>
      ) : (
        <>
          {/* Workflow list */}
          {data.map((wf) => (
            <div
              key={wf.id}
              onClick={() => onSelect(wf.id)}
              style={{
                cursor: 'pointer',
                padding: '8px',
                border: '1px solid #ddd',
                margin: '4px 0',
                borderRadius: '4px',
              }}
            >
              <strong>{wf.name}</strong>
              {' '}
              <StatusBadge status={wf.status} />
              <div style={{ fontSize: '0.85rem', color: '#666' }}>
                {wf.phases.length} phase(s) | {wf.phases.reduce((s, p) => s + p.agents.length, 0)} agent(s) | {new Date(wf.createdAt).toLocaleString()}
              </div>
            </div>
          ))}

          {/* Pagination */}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                padding: '6px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                backgroundColor: page <= 1 ? '#f3f4f6' : '#fff',
                color: page <= 1 ? '#9ca3af' : '#374151',
                cursor: page <= 1 ? 'not-allowed' : 'pointer',
                fontSize: '0.8125rem',
              }}
            >
              Previous
            </button>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                padding: '6px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                backgroundColor: page >= totalPages ? '#f3f4f6' : '#fff',
                color: page >= totalPages ? '#9ca3af' : '#374151',
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                fontSize: '0.8125rem',
              }}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
