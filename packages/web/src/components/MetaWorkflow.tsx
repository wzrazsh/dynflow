import { useState } from 'react';
import { scanRepository, extractDefinitions, registerProject } from '../api/meta';
import type {
  ScanResult,
  ExtractionResult,
  RegistrationResult,
  ScannedFile,
  ExtractedAgent,
  ExtractedSkill,
} from '../api/meta';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MetaWorkflowProps {
  onBack: () => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Step labels
// ---------------------------------------------------------------------------

const STEPS = ['Connect', 'Scan', 'Extract', 'Done'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  let result = parts[parts.length - 1];
  if (result.length > maxLen - 3) {
    result = '...' + result.slice(-(maxLen - 3));
  } else {
    result = '.../' + result;
  }
  return result;
}

function truncateText(text: string, maxLen = 100): string {
  if (!text) return '';
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 720,
    margin: '0 auto',
  },
  stepIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    marginBottom: 28,
  },
  stepItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#fff',
    transition: 'background-color 0.2s',
  },
  stepLabel: {
    fontSize: '0.8125rem',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
  stepConnector: {
    width: 32,
    height: 2,
    margin: '0 8px',
    transition: 'background-color 0.2s',
  },
  card: {
    border: '1px solid #d1d5db',
    borderRadius: 10,
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    margin: '0 0 4px',
    fontSize: '1.125rem',
    fontWeight: 600,
    color: '#1f2937',
  },
  subtitle: {
    margin: '0 0 16px',
    fontSize: '0.8125rem',
    color: '#6b7280',
    lineHeight: 1.5,
  },
  inputLabel: {
    display: 'block',
    marginBottom: 6,
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: '#374151',
  },
  input: {
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    fontSize: '0.875rem',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  inputError: {
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    fontSize: '0.875rem',
    border: '1px solid #dc2626',
    borderRadius: 6,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  errorText: {
    margin: '4px 0 0',
    fontSize: '0.75rem',
    color: '#dc2626',
  },
  primaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 16,
  },
  primaryButtonDisabled: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 24px',
    backgroundColor: '#93c5fd',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'not-allowed',
    marginTop: 16,
  },
  secondaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 24px',
    backgroundColor: '#fff',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 16,
  },
  backLink: {
    background: 'none',
    border: 'none',
    color: '#3b82f6',
    cursor: 'pointer',
    padding: 0,
    fontSize: '0.875rem',
    marginBottom: 16,
    display: 'inline-block',
  },
  errorBox: {
    padding: '10px 14px',
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    borderRadius: 6,
    marginBottom: 12,
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
  successBox: {
    padding: '16px',
    backgroundColor: '#f0fdf4',
    color: '#166534',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: '0.875rem',
    textAlign: 'center' as const,
    border: '1px solid #bbf7d0',
  },
  loadingBox: {
    padding: '20px',
    textAlign: 'center' as const,
    color: '#6b7280',
    fontSize: '0.875rem',
  },
  fileTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.8125rem',
    marginTop: 8,
  },
  fileTableHeader: {
    textAlign: 'left' as const,
    padding: '8px 10px',
    borderBottom: '2px solid #e5e7eb',
    color: '#6b7280',
    fontWeight: 600,
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  fileTableCell: {
    padding: '8px 10px',
    borderBottom: '1px solid #f3f4f6',
    color: '#1f2937',
    verticalAlign: 'top' as const,
  },
  badgeGreen: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: '0.6875rem',
    fontWeight: 600,
    backgroundColor: '#d1fae5',
    color: '#065f46',
  },
  badgeGray: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: '0.6875rem',
    fontWeight: 600,
    backgroundColor: '#f3f4f6',
    color: '#6b7280',
  },
  fileContentPreview: {
    fontSize: '0.6875rem',
    color: '#9ca3af',
    marginTop: 4,
    fontFamily: "'Courier New', Courier, monospace",
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis',
    maxWidth: 300,
  },
  sectionTitle: {
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: '#1f2937',
    margin: '24px 0 12px',
  },
  sectionSubtitle: {
    fontSize: '0.8125rem',
    color: '#6b7280',
    margin: '0 0 12px',
  },
  emptyState: {
    padding: '16px',
    textAlign: 'center' as const,
    color: '#9ca3af',
    fontSize: '0.8125rem',
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    border: '1px dashed #d1d5db',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.8125rem',
    marginBottom: 16,
  },
  tableHeader: {
    textAlign: 'left' as const,
    padding: '8px 10px',
    borderBottom: '2px solid #e5e7eb',
    color: '#6b7280',
    fontWeight: 600,
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    backgroundColor: '#f9fafb',
  },
  tableCell: {
    padding: '8px 10px',
    borderBottom: '1px solid #f3f4f6',
    color: '#1f2937',
    verticalAlign: 'top' as const,
    lineHeight: 1.4,
  },
  warningSection: {
    border: '1px solid #fde68a',
    borderRadius: 6,
    marginTop: 16,
    overflow: 'hidden' as const,
  },
  warningHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 14px',
    backgroundColor: '#fffbeb',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: '#92400e',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
  },
  warningList: {
    padding: '8px 14px 12px',
    backgroundColor: '#fffbeb',
  },
  warningItem: {
    padding: '4px 0',
    fontSize: '0.8125rem',
    color: '#92400e',
    lineHeight: 1.4,
  },
  summaryCard: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    border: '1px solid #e5e7eb',
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: '0.875rem',
    borderBottom: '1px solid #f3f4f6',
  },
  summaryLabel: {
    color: '#6b7280',
  },
  summaryValue: {
    fontWeight: 600,
    color: '#1f2937',
  },
  checkmark: {
    width: 56,
    height: 56,
    borderRadius: '50%',
    backgroundColor: '#d1fae5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 16px',
    fontSize: '1.5rem',
    color: '#059669',
    fontWeight: 700,
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetaWorkflow({ onBack, onError, onSuccess }: MetaWorkflowProps) {
  const [step, setStep] = useState(1);
  const [repoUrl, setRepoUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registrationResult, setRegistrationResult] = useState<RegistrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  // -----------------------------------------------------------------------
  // URL validation
  // -----------------------------------------------------------------------

  function validateUrl(url: string): boolean {
    if (!url.trim()) {
      setUrlError('Please enter a GitHub repository URL');
      return false;
    }
    if (!url.trim().startsWith('https://github.com/')) {
      setUrlError('URL must start with https://github.com/');
      return false;
    }
    setUrlError(null);
    return true;
  }

  // -----------------------------------------------------------------------
  // Step 1 handlers
  // -----------------------------------------------------------------------

  async function handleScan() {
    const trimmed = repoUrl.trim();
    if (!validateUrl(trimmed)) return;

    setScanning(true);
    setError(null);
    try {
      const result = await scanRepository(trimmed);
      if (!result.success) {
        throw new Error(result.error || 'Failed to scan repository');
      }
      setScanResult(result);
      setStep(2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to scan repository';
      setError(msg);
      onError?.(msg);
    } finally {
      setScanning(false);
    }
  }

  // -----------------------------------------------------------------------
  // Step 2 handlers
  // -----------------------------------------------------------------------

  async function handleExtract() {
    if (!scanResult?.files) return;

    setExtracting(true);
    setError(null);
    try {
      const result = await extractDefinitions(scanResult.files);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to extract definitions');
      }
      setExtractionResult(result.data);
      setStep(3);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to extract definitions';
      setError(msg);
      onError?.(msg);
    } finally {
      setExtracting(false);
    }
  }

  // -----------------------------------------------------------------------
  // Step 3 handlers
  // -----------------------------------------------------------------------

  async function handleRegister() {
    if (!scanResult?.projectName || !extractionResult) return;

    setRegistering(true);
    setError(null);
    try {
      const result = await registerProject(
        scanResult.projectName,
        repoUrl.trim(),
        extractionResult.agents,
        extractionResult.skills,
      );
      if (!result.success) {
        throw new Error('Failed to register project');
      }
      setRegistrationResult(result);
      setStep(4);
      onSuccess?.('Project registered successfully');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to register project';
      setError(msg);
      onError?.(msg);
    } finally {
      setRegistering(false);
    }
  }

  // -----------------------------------------------------------------------
  // Step navigation
  // -----------------------------------------------------------------------

  function goToStep(target: number) {
    setError(null);
    setUrlError(null);
    setStep(target);
  }

  // -----------------------------------------------------------------------
  // Step indicator
  // -----------------------------------------------------------------------

  function renderStepIndicator() {
    return (
      <div style={styles.stepIndicator}>
        {STEPS.map((label, i) => {
          const idx = i + 1;
          const isCompleted = idx < step;
          const isCurrent = idx === step;
          const dotColor = isCompleted ? '#10b981' : isCurrent ? '#3b82f6' : '#d1d5db';
          const labelColor = isCompleted || isCurrent ? '#374151' : '#9ca3af';

          return (
            <div key={label} style={styles.stepItem}>
              <span style={{ ...styles.stepDot, backgroundColor: dotColor }}>
                {isCompleted ? '\u2713' : idx}
              </span>
              <span style={{ ...styles.stepLabel, color: labelColor }}>{label}</span>
              {i < STEPS.length - 1 && (
                <span style={{ ...styles.stepConnector, backgroundColor: dotColor }} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Rendering helpers
  // -----------------------------------------------------------------------

  function renderError() {
    if (!error) return null;
    return <div style={styles.errorBox}>{error}</div>;
  }

  function renderBackLink(toStep: number) {
    return (
      <button onClick={() => goToStep(toStep)} style={styles.backLink}>
        &larr; Back
      </button>
    );
  }

  // -----------------------------------------------------------------------
  // Step 1: Source Input
  // -----------------------------------------------------------------------

  function renderStep1() {
    const isValid = repoUrl.trim().startsWith('https://github.com/');
    const canScan = isValid && !scanning;

    return (
      <div style={styles.card}>
        <h2 style={styles.title}>Import from GitHub</h2>
        <p style={styles.subtitle}>
          Enter the URL of a GitHub repository to scan for agent and skill definitions.
        </p>

        {renderError()}

        <label style={styles.inputLabel}>GitHub Repository URL</label>
        <input
          type="text"
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
          onChange={(e) => {
            setRepoUrl(e.target.value);
            if (urlError) setUrlError(null);
          }}
          style={urlError ? styles.inputError : styles.input}
          disabled={scanning}
        />
        {urlError && <p style={styles.errorText}>{urlError}</p>}

        <button
          onClick={handleScan}
          disabled={!canScan}
          style={canScan ? styles.primaryButton : styles.primaryButtonDisabled}
        >
          {scanning ? (
            <>
              <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>&#x21bb;</span>
              Scanning repository...
            </>
          ) : (
            'Scan Repository'
          )}
        </button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Step 2: Scan Results
  // -----------------------------------------------------------------------

  function renderStep2() {
    if (!scanResult) return null;

    const files = scanResult.files || [];
    const defCount = files.filter((f) => f.isDefinition).length;

    return (
      <div>
        {renderBackLink(1)}

        {renderError()}

        <div style={styles.card}>
          <h2 style={styles.title}>{scanResult.projectName || 'Repository Scan'}</h2>
          <p style={styles.subtitle}>
            Found {files.length} file{files.length !== 1 ? 's' : ''}
            {defCount > 0 ? ` (${defCount} definition file${defCount !== 1 ? 's' : ''})` : ''}
          </p>

          {files.length === 0 ? (
            <div style={styles.emptyState}>No files found in this repository</div>
          ) : (
            <table style={styles.fileTable}>
              <thead>
                <tr>
                  <th style={styles.fileTableHeader}>File</th>
                  <th style={{ ...styles.fileTableHeader, width: 80 }}>Size</th>
                  <th style={{ ...styles.fileTableHeader, width: 100 }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file, i) => (
                  <tr key={i}>
                    <td style={styles.fileTableCell}>
                      <span title={file.path}>{truncatePath(file.path)}</span>
                      {file.isDefinition && file.content && (
                        <div style={styles.fileContentPreview}>
                          {truncateText(file.content, 100)}
                        </div>
                      )}
                    </td>
                    <td style={styles.fileTableCell}>{formatSize(file.size)}</td>
                    <td style={styles.fileTableCell}>
                      <span style={file.isDefinition ? styles.badgeGreen : styles.badgeGray}>
                        {file.isDefinition ? 'Definition' : 'Source'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {files.length > 0 && (
            <button
              onClick={handleExtract}
              disabled={extracting}
              style={extracting ? styles.primaryButtonDisabled : styles.primaryButton}
            >
              {extracting ? (
                <>
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>&#x21bb;</span>
                  Extracting definitions...
                </>
              ) : (
                'Extract Definitions'
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: Extraction Results
  // -----------------------------------------------------------------------

  function renderStep3() {
    if (!extractionResult) return null;

    const { agents, skills, warnings } = extractionResult;
    const hasAgents = agents.length > 0;
    const hasSkills = skills.length > 0;
    const hasWarnings = warnings.length > 0;

    return (
      <div>
        {renderBackLink(2)}

        {renderError()}

        <div style={styles.card}>
          <h2 style={styles.title}>Extraction Results</h2>
          <p style={styles.subtitle}>
            Preview the agents and skills found in the scanned files.
          </p>

          {/* Agents section */}
          <h3 style={styles.sectionTitle}>Agents</h3>
          {!hasAgents ? (
            <div style={styles.emptyState}>No agents detected in this repository</div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Name</th>
                  <th style={styles.tableHeader}>Description</th>
                  <th style={styles.tableHeader}>Source File</th>
                  <th style={styles.tableHeader}>Available Skills</th>
                  <th style={styles.tableHeader}>System Prompt</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent, i) => (
                  <tr key={i}>
                    <td style={{ ...styles.tableCell, fontWeight: 600 }}>{agent.name}</td>
                    <td style={styles.tableCell}>{truncateText(agent.description, 60)}</td>
                    <td style={styles.tableCell}>
                      <span title={agent.source}>{truncatePath(agent.source, 30)}</span>
                    </td>
                    <td style={styles.tableCell}>
                      {(agent.availableSkills || []).length > 0
                        ? agent.availableSkills.join(', ')
                        : '-'}
                    </td>
                    <td style={{ ...styles.tableCell, fontFamily: "'Courier New', Courier, monospace", fontSize: '0.6875rem', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {agent.systemPrompt ? truncateText(agent.systemPrompt, 60) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Skills section */}
          <h3 style={styles.sectionTitle}>Skills</h3>
          {!hasSkills ? (
            <div style={styles.emptyState}>No skills detected in this repository</div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Name</th>
                  <th style={styles.tableHeader}>Description</th>
                  <th style={styles.tableHeader}>Category</th>
                  <th style={styles.tableHeader}>Parameters</th>
                  <th style={styles.tableHeader}>Source File</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((skill, i) => (
                  <tr key={i}>
                    <td style={{ ...styles.tableCell, fontWeight: 600 }}>{skill.name}</td>
                    <td style={styles.tableCell}>{truncateText(skill.description, 60)}</td>
                    <td style={styles.tableCell}>
                      <span style={styles.badgeGray}>{skill.category}</span>
                    </td>
                    <td style={styles.tableCell}>
                      {skill.parameters && skill.parameters.length > 0
                        ? skill.parameters.map((p) => p.name).join(', ')
                        : '-'}
                    </td>
                    <td style={styles.tableCell}>
                      <span title={skill.source}>{truncatePath(skill.source, 30)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Warnings section (collapsible) */}
          {hasWarnings && (
            <div style={styles.warningSection}>
              <button
                onClick={() => setWarningsOpen(!warningsOpen)}
                style={styles.warningHeader}
              >
                <span>{warningsOpen ? '\u25BC' : '\u25B6'}</span>
                <span>{warnings.length} Warning{warnings.length !== 1 ? 's' : ''}</span>
              </button>
              {warningsOpen && (
                <div style={styles.warningList}>
                  {warnings.map((w, i) => (
                    <div key={i} style={styles.warningItem}>
                      &bull; {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleRegister}
            disabled={registering}
            style={registering ? styles.primaryButtonDisabled : styles.primaryButton}
          >
            {registering ? (
              <>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>&#x21bb;</span>
                Registering...
              </>
            ) : (
              'Register All'
            )}
          </button>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Step 4: Registration Complete
  // -----------------------------------------------------------------------

  function renderStep4() {
    const reg = registrationResult;

    return (
      <div style={styles.card}>
        <div style={styles.checkmark}>&#x2713;</div>

        <h2 style={{ ...styles.title, textAlign: 'center' as const }}>Registration Complete</h2>
        <p style={{ ...styles.subtitle, textAlign: 'center' as const }}>
          The project has been successfully imported into DynFlow.
        </p>

        {reg && (
          <div style={styles.summaryCard}>
            <div style={styles.summaryRow}>
              <span style={styles.summaryLabel}>Domains</span>
              <span style={styles.summaryValue}>
                {reg.domainId ? '1 created/found' : '0'}
              </span>
            </div>
            <div style={styles.summaryRow}>
              <span style={styles.summaryLabel}>Sources</span>
              <span style={styles.summaryValue}>
                {reg.sourceId ? '1 created/found' : '0'}
              </span>
            </div>
            <div style={styles.summaryRow}>
              <span style={styles.summaryLabel}>Agents Registered</span>
              <span style={styles.summaryValue}>{reg.agentsCount ?? 0}</span>
            </div>
            <div style={styles.summaryRow}>
              <span style={styles.summaryLabel}>Skills Registered</span>
              <span style={styles.summaryValue}>{reg.skillsCount ?? 0}</span>
            </div>
          </div>
        )}

        {reg && reg.warnings && reg.warnings.length > 0 && (
          <div style={{ ...styles.warningSection, marginTop: 0, marginBottom: 16 }}>
            <button
              onClick={() => setWarningsOpen(!warningsOpen)}
              style={styles.warningHeader}
            >
              <span>{warningsOpen ? '\u25BC' : '\u25B6'}</span>
              <span>{reg.warnings.length} Warning{reg.warnings.length !== 1 ? 's' : ''}</span>
            </button>
            {warningsOpen && (
              <div style={styles.warningList}>
                {reg.warnings.map((w, i) => (
                  <div key={i} style={styles.warningItem}>
                    &bull; {w}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={onBack} style={styles.secondaryButton}>
          &larr; Back to Home
        </button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Main render
  // -----------------------------------------------------------------------

  return (
    <div style={styles.container}>
      {renderStepIndicator()}

      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}
      {step === 3 && renderStep3()}
      {step === 4 && renderStep4()}
    </div>
  );
}
