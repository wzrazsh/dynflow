import { useState, useRef } from 'react';
import { post } from '../api/client';
import type { WorkflowTemplate } from '@dynflow/shared';

interface ImportExportProps {
  templateId?: string;
  onImported: (template: WorkflowTemplate) => void;
  onError?: (message: string) => void;
}

interface ExportData {
  content: string;
  filename: string;
}

interface ApiDataResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    border: '1px solid #d1d5db',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    margin: '0 0 12px',
    fontSize: '1rem',
    fontWeight: 600,
  },
  button: {
    padding: '8px 20px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  buttonDisabled: {
    padding: '8px 20px',
    backgroundColor: '#93c5fd',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  fileInput: {
    display: 'block',
    marginBottom: 12,
    fontSize: '0.875rem',
  },
  errorBox: {
    padding: '8px 12px',
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    borderRadius: 6,
    marginBottom: 12,
    fontSize: '0.875rem',
  },
  successBox: {
    padding: '8px 12px',
    backgroundColor: '#f0fdf4',
    color: '#166534',
    borderRadius: 6,
    marginBottom: 12,
    fontSize: '0.875rem',
  },
  description: {
    margin: '0 0 12px',
    fontSize: '0.8125rem',
    color: '#6b7280',
    lineHeight: 1.5,
  },
};

export default function ImportExport({ templateId, onImported, onError }: ImportExportProps) {
  const [exportLoading, setExportLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function clearMessages() {
    setError(null);
    setSuccess(null);
  }

  async function handleExport() {
    if (!templateId) return;
    setExportLoading(true);
    clearMessages();

    try {
      const res = await post<ApiDataResponse<ExportData>>(`/templates/${templateId}/export`, {});
      if (!res.success || !res.data) {
        throw new Error(res.error || 'Export failed');
      }

      const { content, filename } = res.data;

      // Create a download link and trigger it
      const blob = new Blob([content], { type: 'text/typescript' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(`Template exported as ${filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Export failed';
      setError(msg);
      onError?.(msg);
    } finally {
      setExportLoading(false);
    }
  }

  async function handleImport() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError('Please select a .ts file to import');
      return;
    }

    if (!file.name.endsWith('.ts')) {
      setError('Only .ts files are supported');
      return;
    }

    setImportLoading(true);
    clearMessages();

    try {
      const content = await readFileAsText(file);
      const res = await post<ApiDataResponse<WorkflowTemplate>>('/templates/import', { content });

      if (!res.success || !res.data) {
        throw new Error(res.error || 'Import failed');
      }

      setSuccess(`Template "${res.data.name}" imported successfully`);
      onImported(res.data);

      // Reset the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      setError(msg);
      onError?.(msg);
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <div>
      {/* Export Section */}
      {templateId && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Export Template</h3>
          <p style={styles.description}>
            Download this template as a .ts file that can be shared or imported into another workspace.
          </p>
          {error && !success && templateId && <div style={styles.errorBox}>{error}</div>}
          {success && <div style={styles.successBox}>{success}</div>}
          <button
            onClick={handleExport}
            disabled={exportLoading}
            style={exportLoading ? styles.buttonDisabled : styles.button}
          >
            {exportLoading ? 'Exporting...' : 'Export Template'}
          </button>
        </div>
      )}

      {/* Import Section */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Import Template</h3>
        <p style={styles.description}>
          Select a .ts file exported from DynFlow to import it as a new template.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".ts"
          disabled={importLoading}
          style={styles.fileInput}
        />
        {error && !templateId && <div style={styles.errorBox}>{error}</div>}
        {success && !templateId && <div style={styles.successBox}>{success}</div>}
        <button
          onClick={handleImport}
          disabled={importLoading}
          style={importLoading ? styles.buttonDisabled : styles.button}
        >
          {importLoading ? 'Importing...' : 'Import Template'}
        </button>
      </div>
    </div>
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
