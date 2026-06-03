import { useState, type FormEvent, useEffect } from 'react';
import { createWorkflow, orchestrateWorkflow } from '../api/workflows';
import { fetchSystemInfo } from '../api/system';
import type { WorkflowDefinition, RuntimeConfig, SystemInfo } from '@dynflow/shared';
import RuntimeConfigForm from './RuntimeConfigForm';

const EXAMPLE_SCRIPT = `phase("Research", () => {
  agent("researcher-1", "Research quantum computing impact on cryptography");
  agent("researcher-2", "Research post-quantum cryptography standards");
});
phase("Synthesis", () => {
  agent("synthesizer", "Synthesize findings into a report");
});`;

interface CreateWorkflowFormProps {
  onBack: () => void;
  onCreated: () => void;
}

export default function CreateWorkflowForm({ onBack, onCreated }: CreateWorkflowFormProps) {
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [userRequest, setUserRequest] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({});

  useEffect(() => {
    fetchSystemInfo()
      .then(res => {
        if (res.success && res.data) {
          setSystemInfo(res.data);
        }
      })
      .catch(() => {
        // Non-fatal — form still works without system info
      });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Workflow name is required');
      return;
    }
    if (!script.trim()) {
      setError('Workflow script is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await createWorkflow(name.trim(), script.trim(), { runtimeConfig });
      if (result.success) {
        onCreated();
      } else {
        setError(result.error || 'Failed to create workflow');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    } finally {
      setLoading(false);
    }
  }

  function workflowDefToScript(wf: WorkflowDefinition): string {
    function escape(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    }
    const lines: string[] = [];
    for (const phase of wf.phases) {
      lines.push(`phase('${escape(phase.name)}', () => {`);
      for (const agent of phase.agents) {
        const prompt = agent.prompt ? `'${escape(agent.prompt)}'` : '';
        if (agent.agentId && prompt) {
          lines.push(`  agent('${escape(agent.name)}', { agentId: '${escape(agent.agentId)}', prompt: ${prompt} });`);
        } else if (agent.agentId) {
          lines.push(`  agent('${escape(agent.name)}', { agentId: '${escape(agent.agentId)}' });`);
        } else {
          lines.push(`  agent('${escape(agent.name)}', ${prompt || "''"});`);
        }
      }
      lines.push('});');
    }
    return lines.join('\n');
  }

  async function handleGenerate() {
    if (!userRequest.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await orchestrateWorkflow(userRequest.trim());
      if (result.success && result.data) {
        const script = workflowDefToScript(result.data);
        setGeneratedScript(script);
        if (!name.trim()) {
          setName(result.data.name);
        }
      } else {
        setError(result.error || 'Failed to generate workflow');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate workflow');
    } finally {
      setGenerating(false);
    }
  }

  function handleUseScript() {
    if (generatedScript) {
      setScript(generatedScript);
      setMode('manual');
      setGeneratedScript(null);
    }
  }

  return (
    <div>
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

      <h2 style={{ margin: '0 0 20px', fontSize: '1.25rem', fontWeight: 600 }}>
        Create Workflow
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setMode('manual')}
          style={{
            padding: '6px 16px',
            border: mode === 'manual' ? 'none' : '1px solid #d1d5db',
            borderRadius: 6,
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
            backgroundColor: mode === 'manual' ? '#3b82f6' : '#fff',
            color: mode === 'manual' ? '#fff' : '#374151',
          }}
        >
          &#9998;&#65039; Manual
        </button>
        <button
          type="button"
          onClick={() => setMode('ai')}
          style={{
            padding: '6px 16px',
            border: mode === 'ai' ? 'none' : '1px solid #d1d5db',
            borderRadius: 6,
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
            backgroundColor: mode === 'ai' ? '#3b82f6' : '#fff',
            color: mode === 'ai' ? '#fff' : '#374151',
          }}
        >
          &#129302; AI Generate
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 16 }}>
          <label
            htmlFor="wf-name"
            style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
          >
            Workflow Name
          </label>
          <input
            id="wf-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="My Workflow"
            disabled={loading || generating}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Runtime Environment Configuration */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}>
            Runtime Environment
          </label>
          {systemInfo ? (
            <RuntimeConfigForm
              value={runtimeConfig}
              onChange={setRuntimeConfig}
              systemInfo={systemInfo}
              disabled={loading || generating}
            />
          ) : (
            <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Loading available options...</span>
          )}
        </div>

        {mode === 'manual' ? (
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="wf-script"
              style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
            >
              Workflow Script
            </label>
            <textarea
              id="wf-script"
              value={script}
              onChange={(e) => {
                setScript(e.target.value);
                setError(null);
              }}
              placeholder={EXAMPLE_SCRIPT}
              disabled={loading}
              rows={12}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: '0.8125rem',
                fontFamily: "'Courier New', Courier, monospace",
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="wf-request"
              style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
            >
              What do you want the workflow to do?
            </label>
            <textarea
              id="wf-request"
              value={userRequest}
              onChange={(e) => {
                setUserRequest(e.target.value);
                setError(null);
              }}
              placeholder="e.g., Research quantum computing, then synthesize findings into a report"
              disabled={generating}
              rows={6}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: '0.875rem',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || !userRequest.trim()}
                style={{
                  padding: '8px 20px',
                  backgroundColor: generating ? '#6ee7b7' : '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: generating || !userRequest.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {generating ? 'Generating...' : 'Generate Workflow'}
              </button>
            </div>

            {generatedScript && (
              <div style={{ marginTop: 16 }}>
                <label
                  style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
                >
                  Generated Script
                </label>
                <textarea
                  readOnly
                  value={generatedScript}
                  rows={10}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    fontSize: '0.8125rem',
                    fontFamily: "'Courier New', Courier, monospace",
                    resize: 'vertical',
                    boxSizing: 'border-box',
                    backgroundColor: '#f9fafb',
                    color: '#374151',
                  }}
                />
                <button
                  type="button"
                  onClick={handleUseScript}
                  style={{
                    marginTop: 8,
                    padding: '8px 20px',
                    backgroundColor: '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Use This Script
                </button>
              </div>
            )}
          </div>
        )}

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

        {mode === 'manual' && (
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '8px 20px',
              backgroundColor: loading ? '#93c5fd' : '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Creating...' : 'Create Workflow'}
          </button>
        )}
      </form>
    </div>
  );
}
