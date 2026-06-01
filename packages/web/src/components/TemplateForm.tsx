import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { post, put } from '../api/client.js';
import { orchestrateWorkflow } from '../api/workflows';
import type { WorkflowTemplate, ApiResponse, CreateTemplateRequest, WorkflowDefinition } from '@dynflow/shared';

const EXAMPLE_SCRIPT = `phase("Research", () => {
  agent("researcher-1", "Research quantum computing impact on cryptography");
  agent("researcher-2", "Research post-quantum cryptography standards");
});
phase("Synthesis", () => {
  agent("synthesizer", "Synthesize findings into a report");
});`;

interface TemplateFormProps {
  template?: WorkflowTemplate;
  onClose: () => void;
  onSaved: (template: WorkflowTemplate) => void;
  onError?: (message: string) => void;
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const MODAL_STYLE: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: 8,
  padding: 24,
  maxWidth: 600,
  width: '90%',
  maxHeight: '90vh',
  overflowY: 'auto',
  position: 'relative',
};

export default function TemplateForm({ template, onClose, onSaved, onError }: TemplateFormProps) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [script, setScript] = useState(template?.script || '');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>(template?.tags || []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [userRequest, setUserRequest] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);

  const isEdit = !!template;

  function addTag() {
    const trimmed = tagInput.trim().replace(/,+$/, '');
    if (!trimmed) {
      setTagInput('');
      return;
    }
    const newTags = trimmed
      .split(',')
      .map(t => t.trim())
      .filter(t => t && !tags.includes(t));
    if (newTags.length > 0) {
      setTags([...tags, ...newTags]);
    }
    setTagInput('');
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  }

  function handleTagBlur() {
    if (tagInput.trim()) {
      addTag();
    }
  }

  function removeTag(tag: string) {
    setTags(tags.filter(t => t !== tag));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      setError('Template name is required');
      return;
    }
    if (!script.trim()) {
      setError('Template script is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const body: CreateTemplateRequest = {
        name: name.trim(),
        description: description.trim() || undefined,
        script: script.trim(),
        tags: tags.length > 0 ? tags : undefined,
      };

      if (isEdit && template) {
        const result = await put<ApiResponse<WorkflowTemplate>>(`/templates/${template.id}`, body);
        if (result.success && result.data) {
          onSaved(result.data);
        } else {
          const msg = result.error || 'Failed to update template';
          setError(msg);
          onError?.(msg);
        }
      } else {
        const result = await post<ApiResponse<WorkflowTemplate>>('/templates', body);
        if (result.success && result.data) {
          onSaved(result.data);
        } else {
          const msg = result.error || 'Failed to create template';
          setError(msg);
          onError?.(msg);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save template';
      setError(msg);
      onError?.(msg);
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

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  return (
    <div style={OVERLAY_STYLE} onClick={handleOverlayClick}>
      <div style={MODAL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
            {isEdit ? 'Edit Template' : 'Create Template'}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
              color: '#6b7280',
              padding: '4px 8px',
              borderRadius: 4,
            }}
          >
            &times;
          </button>
        </div>

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
          {/* Name */}
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="tmpl-name"
              style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
            >
              Template Name *
            </label>
            <input
              id="tmpl-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="My Template"
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

          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="tmpl-desc"
              style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
            >
              Description
            </label>
            <input
              id="tmpl-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
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

          {mode === 'manual' ? (
            <>
              {/* Script */}
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="tmpl-script"
                  style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
                >
                  Workflow Script *
                </label>
                <textarea
                  id="tmpl-script"
                  value={script}
                  onChange={(e) => { setScript(e.target.value); setError(null); }}
                  placeholder={EXAMPLE_SCRIPT}
                  disabled={loading}
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
                  }}
                />
              </div>

              {/* Tags */}
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="tmpl-tags"
                  style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
                >
                  Tags
                </label>
                <input
                  id="tmpl-tags"
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  onBlur={handleTagBlur}
                  placeholder="Type a tag and press Enter or comma"
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    fontSize: '0.875rem',
                    boxSizing: 'border-box',
                  }}
                />
                {tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          backgroundColor: '#e5e7eb',
                          padding: '2px 8px',
                          borderRadius: 12,
                          fontSize: '0.75rem',
                          lineHeight: '1.5',
                        }}
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTag(tag)}
                          disabled={loading}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            padding: 0,
                            fontSize: '0.875rem',
                            lineHeight: 1,
                            color: '#6b7280',
                          }}
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="tmpl-request"
                style={{ display: 'block', marginBottom: 6, fontWeight: 500, fontSize: '0.875rem' }}
              >
                What do you want the workflow to do?
              </label>
              <textarea
                id="tmpl-request"
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

          {/* Error */}
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

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading || generating}
              style={{
                padding: '8px 20px',
                backgroundColor: '#fff',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: loading || generating ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
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
                {loading ? 'Saving...' : isEdit ? 'Update Template' : 'Create Template'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
