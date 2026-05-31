import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { post, put } from '../api/client.js';
import type { WorkflowTemplate, ApiResponse, CreateTemplateRequest } from '@dynflow/shared';

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
          </div>

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
              disabled={loading}
              style={{
                padding: '8px 20px',
                backgroundColor: '#fff',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
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
          </div>
        </form>
      </div>
    </div>
  );
}
