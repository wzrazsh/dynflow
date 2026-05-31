import { useState, type FormEvent } from 'react';
import { createWorkflow } from '../api/workflows';

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
      const result = await createWorkflow(name.trim(), script.trim());
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
      </form>
    </div>
  );
}
