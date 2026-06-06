import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchDomains, fetchAgentSources, fetchRoles, fetchAgentsByRole } from '../api/registry';
import type { Domain, AgentSource, AgentRole, PredefinedAgent } from '@dynflow/shared';

export interface AgentPickerProps {
  selectedAgents: string[];
  onSelectionChange: (agentIds: string[]) => void;
  maxSelections?: number;
}

// ─── Level section header ────────────────────────────────────
function LevelHeader({
  level,
  title,
  count,
  disabled,
}: {
  level: number;
  title: string;
  count: number;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        padding: '10px 14px',
        backgroundColor: disabled ? '#f9fafb' : '#f3f4f6',
        borderBottom: '1px solid #e5e7eb',
        fontSize: '0.8125rem',
        fontWeight: 600,
        color: disabled ? '#9ca3af' : '#374151',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: '50%',
          backgroundColor: disabled ? '#e5e7eb' : '#3b82f6',
          color: '#fff',
          fontSize: '0.6875rem',
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {level}
      </span>
      <span style={{ flex: 1 }}>{title}</span>
      {!disabled && (
        <span
          style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            fontWeight: 400,
          }}
        >
          {count} available
        </span>
      )}
    </div>
  );
}

// ─── Level list item ─────────────────────────────────────────
function LevelItem<T extends { id: string; name: string; description?: string }>({
  item,
  isSelected,
  onClick,
  disabled,
  children,
}: {
  item: T;
  isSelected: boolean;
  onClick: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid #f3f4f6',
        cursor: disabled ? 'default' : 'pointer',
        backgroundColor: isSelected ? '#eff6ff' : 'transparent',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 0.1s',
      }}
      onMouseEnter={(e) => {
        if (!isSelected && !disabled) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f9fafb';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
        }
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          border: isSelected ? '5px solid #3b82f6' : '2px solid #d1d5db',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'border 0.1s',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.875rem',
            fontWeight: isSelected ? 600 : 400,
            color: '#1f2937',
          }}
        >
          {item.name}
        </div>
        {item.description && (
          <div
            style={{
              fontSize: '0.75rem',
              color: '#6b7280',
              marginTop: 2,
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.description}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Agent checkbox item ─────────────────────────────────────
function AgentItem({
  agent,
  isSelected,
  onToggle,
  disabled,
}: {
  agent: PredefinedAgent;
  isSelected: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid #f3f4f6',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggle}
        disabled={disabled}
        style={{ marginTop: 2, cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.875rem',
            fontWeight: isSelected ? 600 : 400,
            color: '#1f2937',
          }}
        >
          {agent.name}
        </div>
        {agent.description && (
          <div
            style={{
              fontSize: '0.75rem',
              color: '#6b7280',
              marginTop: 2,
              lineHeight: 1.3,
            }}
          >
            {agent.description}
          </div>
        )}
        {agent.availableSkills && agent.availableSkills.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {agent.availableSkills.map((skillId) => (
              <span
                key={skillId}
                style={{
                  padding: '1px 6px',
                  backgroundColor: '#ede9fe',
                  color: '#5b21b6',
                  borderRadius: 4,
                  fontSize: '0.6875rem',
                  fontWeight: 500,
                  lineHeight: '1.5',
                }}
              >
                {skillId}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Chip ────────────────────────────────────────────────────
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        backgroundColor: '#dbeafe',
        color: '#1e40af',
        borderRadius: 4,
        fontSize: '0.8125rem',
        fontWeight: 500,
        lineHeight: '1.4',
      }}
    >
      {label}
      <button
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: '#1e40af',
          fontSize: '1rem',
          lineHeight: 1,
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          opacity: 0.6,
        }}
        aria-label={`Remove ${label}`}
      >
        &times;
      </button>
    </span>
  );
}

// ─── Main component ──────────────────────────────────────────
export default function AgentPicker({
  selectedAgents,
  onSelectionChange,
  maxSelections = 10,
}: AgentPickerProps) {
  // Data lists
  const [domains, setDomains] = useState<Domain[]>([]);
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [agents, setAgents] = useState<PredefinedAgent[]>([]);

  // Selection state (levels 1-3 are single-select)
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Loading state per level
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // Error state per level
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // Agent name cache for chip display
  const agentNameCache = useRef<Record<string, string>>({});

  const selectedSet = useRef(new Set(selectedAgents));
  selectedSet.current = new Set(selectedAgents);

  // ── Load domains on mount ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setDomainsLoading(true);
    setDomainsError(null);

    fetchDomains()
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setDomains(res.data);
        } else {
          setDomainsError('Failed to load domains');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setDomainsError(err instanceof Error ? err.message : 'Failed to load domains');
      })
      .finally(() => {
        if (!cancelled) setDomainsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load sources when domain changes ──────────────────────
  useEffect(() => {
    if (!selectedDomainId) return;

    let cancelled = false;
    setSourcesLoading(true);
    setSourcesError(null);
    setSources([]);
    setSelectedSourceId(null);
    setSelectedRoleId(null);
    setAgents([]);

    fetchAgentSources(selectedDomainId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setSources(res.data);
        } else {
          setSourcesError('Failed to load sources');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcesError(err instanceof Error ? err.message : 'Failed to load sources');
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDomainId]);

  // ── Load roles when source changes ─────────────────────────
  useEffect(() => {
    if (!selectedSourceId) return;

    let cancelled = false;
    setRolesLoading(true);
    setRolesError(null);
    setRoles([]);
    setSelectedRoleId(null);
    setAgents([]);

    fetchRoles(selectedSourceId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setRoles(res.data);
        } else {
          setRolesError('Failed to load roles');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setRolesError(err instanceof Error ? err.message : 'Failed to load roles');
      })
      .finally(() => {
        if (!cancelled) setRolesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSourceId]);

  // ── Load agents when role changes ──────────────────────────
  useEffect(() => {
    if (!selectedRoleId) return;

    let cancelled = false;
    setAgentsLoading(true);
    setAgentsError(null);
    setAgents([]);

    fetchAgentsByRole(selectedRoleId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setAgents(res.data);
          // Update name cache
          res.data.forEach((a) => {
            agentNameCache.current[a.id] = a.name;
          });
        } else {
          setAgentsError('Failed to load agents');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setAgentsError(err instanceof Error ? err.message : 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRoleId]);

  // ── Handlers ───────────────────────────────────────────────
  const handleSelectDomain = useCallback((id: string) => {
    setSelectedDomainId((prev) => (prev === id ? prev : id));
  }, []);

  const handleSelectSource = useCallback((id: string) => {
    setSelectedSourceId((prev) => (prev === id ? prev : id));
  }, []);

  const handleSelectRole = useCallback((id: string) => {
    setSelectedRoleId((prev) => (prev === id ? prev : id));
  }, []);

  const handleToggleAgent = useCallback(
    (agentId: string) => {
      const current = selectedSet.current;
      if (current.has(agentId)) {
        onSelectionChange(selectedAgents.filter((id) => id !== agentId));
      } else if (selectedAgents.length < maxSelections) {
        onSelectionChange([...selectedAgents, agentId]);
      }
    },
    [selectedAgents, onSelectionChange, maxSelections],
  );

  const handleRemoveAgent = useCallback(
    (agentId: string) => {
      onSelectionChange(selectedAgents.filter((id) => id !== agentId));
    },
    [selectedAgents, onSelectionChange],
  );

  // ── Helpers ────────────────────────────────────────────────
  const isAtMax = selectedAgents.length >= maxSelections;

  function renderLevelContent<T>(
    items: T[],
    loading: boolean,
    error: string | null,
    selectedId: string | null,
    onSelect: (id: string) => void,
    emptyMessage: string,
  ) {
    if (loading) {
      return (
        <div style={{ padding: 16, color: '#9ca3af', fontSize: '0.8125rem', textAlign: 'center' }}>
          Loading...
        </div>
      );
    }
    if (error) {
      return (
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: 4,
            margin: 8,
            fontSize: '0.8125rem',
          }}
        >
          {error}
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div style={{ padding: 16, color: '#9ca3af', fontSize: '0.8125rem', textAlign: 'center' }}>
          {emptyMessage}
        </div>
      );
    }
    return items.map((item: T) => (
      <LevelItem
        key={item.id}
        item={item}
        isSelected={item.id === selectedId}
        onClick={() => onSelect(item.id)}
      >
        {item.id === selectedId && (
          <span style={{ fontSize: '0.75rem', color: '#3b82f6', fontWeight: 500 }}>Selected</span>
        )}
      </LevelItem>
    ));
  }

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: '#fff',
      }}
    >
      {/* ── Title ────────────────────────────────────────────── */}
      <div
        style={{
          padding: '12px 14px',
          backgroundColor: '#f9fafb',
          borderBottom: '1px solid #e5e7eb',
          fontSize: '0.9375rem',
          fontWeight: 700,
          color: '#1f2937',
        }}
      >
        Select Agents
      </div>

      {/* ── Level 1: Domain ─────────────────────────────────── */}
      <div style={{ borderBottom: '1px solid #e5e7eb' }}>
        <LevelHeader level={1} title="Select Domain" count={domains.length} disabled={false} />
        {renderLevelContent(
          domains,
          domainsLoading,
          domainsError,
          selectedDomainId,
          handleSelectDomain,
          'No domains available',
        )}
      </div>

      {/* ── Level 2: Source ─────────────────────────────────── */}
      {selectedDomainId && (
        <div style={{ borderBottom: '1px solid #e5e7eb' }}>
          <LevelHeader level={2} title="Select Source" count={sources.length} disabled={false} />
          {renderLevelContent(
            sources,
            sourcesLoading,
            sourcesError,
            selectedSourceId,
            handleSelectSource,
            'No sources for this domain',
          )}
        </div>
      )}

      {/* ── Level 3: Role ───────────────────────────────────── */}
      {selectedSourceId && (
        <div style={{ borderBottom: '1px solid #e5e7eb' }}>
          <LevelHeader level={3} title="Select Role" count={roles.length} disabled={false} />
          {renderLevelContent(
            roles,
            rolesLoading,
            rolesError,
            selectedRoleId,
            handleSelectRole,
            'No roles for this source',
          )}
        </div>
      )}

      {/* ── Level 4: Agent ──────────────────────────────────── */}
      {selectedRoleId && (
        <div>
          <LevelHeader
            level={4}
            title="Select Agents"
            count={agents.length}
            disabled={false}
          />
          {agentsLoading && (
            <div
              style={{
                padding: 16,
                color: '#9ca3af',
                fontSize: '0.8125rem',
                textAlign: 'center',
              }}
            >
              Loading...
            </div>
          )}
          {agentsError && (
            <div
              style={{
                padding: '8px 12px',
                backgroundColor: '#fee2e2',
                color: '#991b1b',
                borderRadius: 4,
                margin: 8,
                fontSize: '0.8125rem',
              }}
            >
              {agentsError}
            </div>
          )}
          {!agentsLoading && !agentsError && agents.length === 0 && (
            <div
              style={{
                padding: 16,
                color: '#9ca3af',
                fontSize: '0.8125rem',
                textAlign: 'center',
              }}
            >
              No agents for this role
            </div>
          )}
          {!agentsLoading &&
            !agentsError &&
            agents.map((agent) => (
              <AgentItem
                key={agent.id}
                agent={agent}
                isSelected={selectedSet.current.has(agent.id)}
                onToggle={() => handleToggleAgent(agent.id)}
                disabled={isAtMax && !selectedSet.current.has(agent.id)}
              />
            ))}
        </div>
      )}

      {/* ── Selected chips ──────────────────────────────────── */}
      {selectedAgents.length > 0 && (
        <div
          style={{
            padding: '12px 14px',
            borderTop: '1px solid #e5e7eb',
            backgroundColor: '#f9fafb',
          }}
        >
          <div
            style={{
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: '#374151',
              marginBottom: 8,
            }}
          >
            Selected ({selectedAgents.length}/{maxSelections})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {selectedAgents.map((agentId) => (
              <Chip
                key={agentId}
                label={agentNameCache.current[agentId] || agentId}
                onRemove={() => handleRemoveAgent(agentId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
