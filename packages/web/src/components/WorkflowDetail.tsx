import { useState, useEffect, useCallback, useRef } from 'react';
import type { WorkflowRun, SystemInfo, RuntimeConfig } from '@dynflow/shared';
import { fetchWorkflow, controlWorkflow } from '../api/workflows';
import { fetchSystemInfo } from '../api/system';
import { useSSE } from '../hooks/useSSE';
import StatusBadge from './StatusBadge';
import RuntimeConfigChips from './RuntimeConfigChips';
import StartRunDialog from './StartRunDialog';

interface WorkflowDetailProps {
  workflowId: string;
  onBack?: () => void;
  /**
   * Optional callback fired when the user clicks the "Source: template v<n>"
   * pill on a workflow run that was created from a template. The parent
   * (App) wires this to switch the view to the template detail screen.
   * If omitted, the pill falls back to a plain `href` so the link still
   * works for future routing changes.
   */
  onNavigateToTemplate?: (templateId: string) => void;
}

const POLL_INTERVAL = 3000;

export default function WorkflowDetail({
  workflowId,
  onBack,
  onNavigateToTemplate,
}: WorkflowDetailProps) {
  const [workflow, setWorkflow] = useState<WorkflowRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [startDialogOpen, setStartDialogOpen] = useState(false);

  const loadWorkflow = useCallback(async () => {
    try {
      const result = await fetchWorkflow(workflowId);
      if (result.success && result.data) {
        setWorkflow(result.data);
        setError(null);
      } else {
        setError(result.error || 'Failed to load workflow');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflow');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  // SSE live updates 鈥?only subscribe when the workflow is active
  const workflowForSSE = workflow && (workflow.status === 'running' || workflow.status === 'paused') ? workflowId : null;
  const { events, status: sseStatus } = useSSE(workflowForSSE);
  const prevEventCountRef = useRef(0);

  // When SSE events arrive, re-fetch from API for fresh data
  useEffect(() => {
    if (events.length > prevEventCountRef.current) {
      prevEventCountRef.current = events.length;
      loadWorkflow();
    }
  }, [events.length, loadWorkflow]);

  // Fetch system info on mount
  useEffect(() => {
    fetchSystemInfo()
      .then(res => {
        if (res.success && res.data) setSystemInfo(res.data);
      })
      .catch(() => {});
  }, []);

  // Initial load
  useEffect(() => {
    loadWorkflow();
  }, [loadWorkflow]);

  // Poll when running or paused (as fallback for SSE)
  useEffect(() => {
    if (!workflow) return;
    if (workflow.status !== 'running' && workflow.status !== 'paused') return;

    const interval = setInterval(loadWorkflow, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [workflow?.status, loadWorkflow]);

  async function handleControl(action: 'start' | 'pause' | 'resume' | 'stop') {
    setActionLoading(action);
    try {
      if (action === 'start') {
        // Open dialog instead of directly starting
        setStartDialogOpen(true);
        setActionLoading(null);
        return;
      }
      await controlWorkflow(workflowId, action);
      await loadWorkflow();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} workflow`);
    } finally {
      setActionLoading(null);
    }
  }

  const handleStartConfirm = useCallback(async (config: RuntimeConfig) => {
    await controlWorkflow(workflowId, 'start', { runtimeConfig: config });
    await loadWorkflow();
  }, [workflowId, loadWorkflow]);

  function togglePhase(phaseId: string) {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function truncate(text: string, max = 120): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + '...';
  }

  if (loading) {
    return <div style={{ color: '#6b7280', fontSize: '0.875rem' }}>Loading...</div>;
  }

  if (error) {
    return (
      <div>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: 'none',
              border: 'none',
              color: '#3b82f6',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 16,
              fontSize: '0.875rem',
            }}
          >
            &larr; Back to list
          </button>
        )}
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: 6,
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!workflow) {
    return null;
  }

  const isRunning = workflow.status === 'running';
  const isPaused = workflow.status === 'paused';
  const isPending = workflow.status === 'pending';
  const isTerminal = ['completed', 'failed', 'stopped'].includes(workflow.status);

  // Resolve runtime config: run override wins, then definition default
  const resolvedRuntimeConfig: RuntimeConfig | undefined =
    workflow?.runtimeConfig ?? workflow?.definition?.runtimeConfig;
  const hasRuntimeConfig = !!resolvedRuntimeConfig?.runner || !!resolvedRuntimeConfig?.llmProvider || !!resolvedRuntimeConfig?.model;
  const chipsSource = workflow?.runtimeConfig ? 'override' : 'resolved';

  return (
    <>
      <div>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: 'none',
              border: 'none',
              color: '#3b82f6',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 16,
              fontSize: '0.875rem',
            }}
          >
            &larr; Back to list
          </button>
        )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{workflow.name}</h2>
        <StatusBadge status={workflow.status} />
        {workflow.templateId && (
          <a
            href={`/templates/${workflow.templateId}`}
            onClick={(e) => {
              if (onNavigateToTemplate) {
                e.preventDefault();
                onNavigateToTemplate(workflow.templateId!);
              }
            }}
            style={{
              fontSize: '0.75rem',
              color: '#1d4ed8',
              textDecoration: 'none',
              border: '1px solid #bfdbfe',
              backgroundColor: '#eff6ff',
              borderRadius: 10,
              padding: '1px 8px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            title="Open the source template"
          >
            Source: template v{workflow.templateVersion ?? '?'}
          </a>
        )}
        {workflowForSSE && (
          <span
            style={{
              fontSize: '0.6875rem',
              color: sseStatus.connected ? '#059669' : '#d97706',
              marginLeft: 4,
            }}
          >
            {sseStatus.connected ? '鈼?Live' : sseStatus.reconnecting ? '鉄?Reconnecting...' : ''}
          </span>
        )}
      </div>

      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: '0.8125rem' }}>
        Created: {formatTime(workflow.createdAt)}
      </p>

      {/* Runtime config chips */}
      {hasRuntimeConfig && (
        <div style={{ marginTop: 12, marginBottom: 12 }}>
          <RuntimeConfigChips
            runner={resolvedRuntimeConfig?.runner}
            llmProvider={resolvedRuntimeConfig?.llmProvider}
            model={resolvedRuntimeConfig?.model}
            source={chipsSource}
          />
        </div>
      )}

      {/* Control buttons */}
      {!isTerminal && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {isPending && (
            <ControlButton
              label="Start"

              onClick={() => handleControl('start')}
              loading={actionLoading === 'start'}
              color="#059669"
            />
          )}
          {isRunning && (
            <>
              <ControlButton
                label="Pause"

                onClick={() => handleControl('pause')}
                loading={actionLoading === 'pause'}
                color="#d97706"
              />
              <ControlButton
                label="Stop"

                onClick={() => handleControl('stop')}
                loading={actionLoading === 'stop'}
                color="#dc2626"
              />
            </>
          )}
          {isPaused && (
            <>
              <ControlButton
                label="Resume"

                onClick={() => handleControl('resume')}
                loading={actionLoading === 'resume'}
                color="#059669"
              />
              <ControlButton
                label="Stop"

                onClick={() => handleControl('stop')}
                loading={actionLoading === 'stop'}
                color="#dc2626"
              />
            </>
          )}
        </div>
      )}

      {/* Error display for actions */}
      {error && (
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Phase list */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <div
          style={{
            padding: '10px 14px',
            backgroundColor: '#f9fafb',
            borderBottom: '1px solid #e5e7eb',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: '#374151',
          }}
        >
          Phases ({workflow.phases.length})
        </div>

        {workflow.phases.length === 0 && (
          <div style={{ padding: 16, color: '#9ca3af', fontSize: '0.875rem', textAlign: 'center' }}>
            No phases defined
          </div>
        )}

        {workflow.phases.map((phase) => {
          const isExpanded = expandedPhases.has(phase.id);
          return (
            <div key={phase.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
              {/* Phase header */}
              <button
                onClick={() => togglePhase(phase.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.875rem',
                  color: '#1f2937',
                }}
              >
                <span
                  style={{
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                    fontSize: '0.75rem',
                    color: '#9ca3af',
                  }}
                >
                  &#9654;
                </span>
                <span style={{ flex: 1, fontWeight: 500 }}>{phase.name}</span>
                <StatusBadge status={phase.status} />
              </button>

              {/* Agent list (collapsible) */}
              {isExpanded && (
                <div style={{ borderTop: '1px solid #f3f4f6' }}>
                  {phase.agents.map((agent) => (
                    <div
                      key={agent.id}
                      style={{
                        padding: '10px 14px 10px 36px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 6,
                        }}
                      >
                        <span style={{ fontWeight: 500, fontSize: '0.8125rem' }}>
                          {agent.name}
                        </span>
                        <StatusBadge status={agent.status} />
                        {(agent.noVncUrl || agent.cuaApiUrl) && (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              marginLeft: 'auto',
                              fontSize: '0.6875rem',
                              color: '#6b7280',
                            }}
                          >
                            {agent.noVncUrl && (
                              <a
                                href={agent.noVncUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  color: '#1d4ed8',
                                  textDecoration: 'none',
                                  border: '1px solid #bfdbfe',
                                  backgroundColor: '#eff6ff',
                                  borderRadius: 10,
                                  padding: '1px 8px',
                                  fontWeight: 600,
                                }}
                                title={`Open Cua desktop: ${agent.noVncUrl}`}
                              >
                                馃枼锔?Cua Desktop
                              </a>
                            )}
                            {agent.cuaApiUrl && (
                              <a
                                href={agent.cuaApiUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  color: '#6b7280',
                                  textDecoration: 'none',
                                  border: '1px solid #e5e7eb',
                                  backgroundColor: '#f9fafb',
                                  borderRadius: 10,
                                  padding: '1px 8px',
                                  fontWeight: 600,
                                }}
                                title={`Cua computer-server API: ${agent.cuaApiUrl}`}
                              >
                                Cua API
                              </a>
                            )}
                          </span>
                        )}
                      </div>

                      <p
                        style={{
                          margin: '0 0 4px',
                          fontSize: '0.8125rem',
                          color: '#4b5563',
                          lineHeight: 1.4,
                        }}
                      >
                        <span style={{ fontWeight: 500 }}>Prompt:</span>{' '}
                        {truncate(agent.prompt)}
                      </p>

                      {agent.output && (
                        <div style={{ marginTop: 6 }}>
                          <span
                            style={{
                              fontWeight: 500,
                              fontSize: '0.75rem',
                              color: '#374151',
                              display: 'block',
                              marginBottom: 2,
                            }}
                          >
                            Output:
                          </span>
                          <pre
                            style={{
                              margin: 0,
                              padding: 8,
                              backgroundColor: '#f9fafb',
                              border: '1px solid #e5e7eb',
                              borderRadius: 4,
                              fontSize: '0.75rem',
                              fontFamily: "'Courier New', Courier, monospace",
                              overflowX: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              lineHeight: 1.4,
                            }}
                          >
                            {truncate(agent.output, 500)}
                          </pre>
                        </div>
                      )}

                      {agent.error && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '6px 8px',
                            backgroundColor: '#fee2e2',
                            color: '#991b1b',
                            borderRadius: 4,
                            fontSize: '0.75rem',
                            fontFamily: "'Courier New', Courier, monospace",
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {agent.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>

    <StartRunDialog
      open={startDialogOpen}
      onClose={() => setStartDialogOpen(false)}
      onConfirm={handleStartConfirm}
      defaultRuntimeConfig={workflow?.definition?.runtimeConfig}
      systemInfo={systemInfo}
      workflowName={workflow?.name ?? ''}
    />
    </>
  );
}

// Small helper component for control buttons
function ControlButton({
  label,
  onClick,
  loading,
  color,
}: {
  label: string;
  onClick: () => void;
  loading: boolean;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        padding: '6px 16px',
        backgroundColor: loading ? '#d1d5db' : color,
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        fontSize: '0.8125rem',
        fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1,
      }}
    >
      {loading ? '...' : label}
    </button>
  );
}
