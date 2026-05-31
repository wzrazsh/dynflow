import { useState, useEffect, useCallback } from 'react';
import type { ProjectDetail as ProjectDetailType, VersionMeta } from '@dynflow/shared';
import { fetchProject, fetchVersions, readFile, runProject, approveVersion } from '../api/projects';
import StatusBadge from './StatusBadge';

const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.ts', '.tsx', '.json', '.md', '.txt', '.yaml', '.yml', '.xml', '.svg']);
const MAX_PREVIEW_SIZE = 500 * 1024; // 500KB

interface ProjectDetailProps {
  projectName: string;
  onBack: () => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

function getFileExtension(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.substring(idx).toLowerCase() : '';
}

function isTextFile(path: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true;
    if (mimeType === 'application/json') return true;
  }
  const ext = getFileExtension(path);
  return TEXT_EXTENSIONS.has(ext);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(path: string): string {
  const ext = getFileExtension(path);
  const iconMap: Record<string, string> = {
    '.html': '🌐',
    '.css': '🎨',
    '.js': '⚡',
    '.ts': '📘',
    '.tsx': '⚛️',
    '.json': '📋',
    '.md': '📝',
    '.txt': '📄',
    '.yaml': '⚙️',
    '.yml': '⚙️',
    '.xml': '📰',
    '.svg': '🖼️',
  };
  return iconMap[ext] || '📄';
}

interface FileTreeItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeItem[];
}

function buildFileTree(files: string[]): FileTreeItem[] {
  const root: FileTreeItem[] = [];
  for (const file of files) {
    const parts = file.replace(/^\/+/, '').split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let existing = current.find((c) => c.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isDirectory: !isLast,
          children: [],
        };
        current.push(existing);
      }
      current = existing.children;
    }
  }
  return root;
}

function FileTree({
  items,
  selectedFile,
  onSelect,
  depth = 0,
}: {
  items: FileTreeItem[];
  selectedFile: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      {items.map((item) => {
        const isSelected = item.path === selectedFile;
        return (
          <div key={item.path}>
            <div
              onClick={() => !item.isDirectory && onSelect(item.path)}
              style={{
                padding: '3px 8px 3px ' + (8 + depth * 16) + 'px',
                cursor: item.isDirectory ? 'default' : 'pointer',
                borderRadius: 3,
                fontSize: '0.8125rem',
                backgroundColor: isSelected ? '#dbeafe' : 'transparent',
                color: item.isDirectory ? '#6b7280' : isSelected ? '#1e40af' : '#1f2937',
                fontWeight: item.isDirectory ? 600 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={item.path}
            >
              {item.isDirectory ? (
                <span style={{ marginRight: 4 }}>📁</span>
              ) : (
                <span style={{ marginRight: 4 }}>{getFileIcon(item.path)}</span>
              )}
              {item.name}
            </div>
            {item.children.length > 0 && (
              <FileTree
                items={item.children}
                selectedFile={selectedFile}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ProjectDetail({ projectName, onBack, onError, onSuccess }: ProjectDetailProps) {
  const [project, setProject] = useState<ProjectDetailType | null>(null);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileMimeType, setFileMimeType] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [approveLoading, setApproveLoading] = useState<number | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const [proj, vers] = await Promise.all([
        fetchProject(projectName),
        fetchVersions(projectName),
      ]);
      setProject(proj);
      setVersions(vers);
      setError(null);
      if (!selectedVersion && vers.length > 0) {
        setSelectedVersion(vers[0].version);
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [projectName, selectedVersion, onError]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // Load file content when a file is selected
  useEffect(() => {
    if (!selectedFile || !selectedVersion) {
      setFileContent(null);
      setFileMimeType(null);
      return;
    }

    if (!isTextFile(selectedFile)) {
      setFileContent(null);
      setFileMimeType(null);
      return;
    }

    let cancelled = false;
    setFileLoading(true);

    (async () => {
      try {
        const result = await readFile(projectName, selectedVersion, selectedFile);
        if (!cancelled) {
          if (result.content.length > MAX_PREVIEW_SIZE) {
            setFileContent(null); // too large, show metadata only
          } else {
            setFileContent(result.content);
          }
          setFileMimeType(result.mimeType);
        }
      } catch {
        if (!cancelled) {
          setFileContent(null);
          setFileMimeType('text/plain');
        }
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedFile, selectedVersion, projectName]);

  async function handleRun() {
    if (!prompt.trim()) return;
    setRunLoading(true);
    try {
      const result = await runProject(projectName, prompt);
      onSuccess?.(`Iteration started: version ${result.version}`);
      setPrompt('');
      // Reload project and versions
      const [proj, vers] = await Promise.all([
        fetchProject(projectName),
        fetchVersions(projectName),
      ]);
      setProject(proj);
      setVersions(vers);
      setSelectedVersion(result.version);
    } catch (e) {
      onError?.(String(e));
    } finally {
      setRunLoading(false);
    }
  }

  async function handleApprove(version: number) {
    setApproveLoading(version);
    try {
      await approveVersion(projectName, version);
      onSuccess?.(`Version ${version} approved`);
      const vers = await fetchVersions(projectName);
      setVersions(vers);
    } catch (e) {
      onError?.(String(e));
    } finally {
      setApproveLoading(null);
    }
  }

  if (loading) {
    return <div style={{ color: '#6b7280', fontSize: '0.875rem' }}>Loading...</div>;
  }

  if (error) {
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
          &larr; Back to projects
        </button>
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

  if (!project) return null;

  const activeVersion = versions.find((v) => v.version === selectedVersion);
  const fileTreeItems = activeVersion ? buildFileTree(activeVersion.files) : [];

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
        &larr; Back to projects
      </button>

      {/* Project header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
          {project.projectName}
        </h2>
      </div>

      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: '0.8125rem' }}>
        Created: {new Date(project.createdAt).toLocaleString()} | Versions: {project.versions.length}
      </p>

      {/* Main layout: version sidebar + content area */}
      <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
        {/* Version sidebar */}
        <div
          style={{
            width: 160,
            flexShrink: 0,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              backgroundColor: '#f9fafb',
              borderBottom: '1px solid #e5e7eb',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: '#374151',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Versions
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {versions.length === 0 && (
              <div style={{ padding: 12, color: '#9ca3af', fontSize: '0.8125rem', textAlign: 'center' }}>
                No versions
              </div>
            )}
            {versions.map((v) => {
              const isSelected = v.version === selectedVersion;
              return (
                <div key={v.version}>
                  <div
                    onClick={() => {
                      setSelectedVersion(v.version);
                      setSelectedFile(null);
                      setFileContent(null);
                    }}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? '#eff6ff' : 'transparent',
                      borderBottom: '1px solid #f3f4f6',
                      fontSize: '0.8125rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontWeight: isSelected ? 600 : 400 }}>
                        v{v.version}
                      </span>
                      <StatusBadge status={v.status} />
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                      {new Date(v.createdAt).toLocaleDateString()}
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
                      {v.fileCount} files
                    </div>
                  </div>
                  {v.status === 'completed' && (
                    <div style={{ padding: '0 12px 6px' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleApprove(v.version);
                        }}
                        disabled={approveLoading === v.version}
                        style={{
                          padding: '2px 8px',
                          backgroundColor: approveLoading === v.version ? '#d1d5db' : '#059669',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 4,
                          fontSize: '0.6875rem',
                          cursor: approveLoading === v.version ? 'not-allowed' : 'pointer',
                          width: '100%',
                        }}
                      >
                        {approveLoading === v.version ? '...' : 'Approve'}
                      </button>
                    </div>
                  )}
                  {v.error && (
                    <div
                      style={{
                        padding: '0 12px 6px',
                        fontSize: '0.625rem',
                        color: '#991b1b',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={v.error}
                    >
                      {v.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* File browser + preview */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!activeVersion && (
            <div
              style={{
                padding: 24,
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: '0.875rem',
              }}
            >
              Select a version to browse files
            </div>
          )}

          {activeVersion && (
            <>
              {/* File browser */}
              <div
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '8px 12px',
                    backgroundColor: '#f9fafb',
                    borderBottom: '1px solid #e5e7eb',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: '#374151',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>Files (v{activeVersion.version})</span>
                  <span style={{ fontWeight: 400, fontSize: '0.6875rem', color: '#9ca3af' }}>
                    {activeVersion.fileCount} items &middot; {formatFileSize(activeVersion.totalSize)}
                  </span>
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 0' }}>
                  {activeVersion.files.length === 0 ? (
                    <div style={{ padding: 12, color: '#9ca3af', fontSize: '0.8125rem', textAlign: 'center' }}>
                      No files in this version
                    </div>
                  ) : (
                    <FileTree
                      items={fileTreeItems}
                      selectedFile={selectedFile}
                      onSelect={(path) => setSelectedFile(path)}
                    />
                  )}
                </div>
              </div>

              {/* File preview */}
              <div
                style={{
                  flex: 1,
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    padding: '8px 12px',
                    backgroundColor: '#f9fafb',
                    borderBottom: '1px solid #e5e7eb',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: '#374151',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>
                    {selectedFile ? (
                      <>
                        <span style={{ marginRight: 4 }}>{getFileIcon(selectedFile)}</span>
                        {selectedFile}
                      </>
                    ) : (
                      'File Preview'
                    )}
                  </span>
                  {selectedFile && fileContent !== null && (
                    <button
                      onClick={async () => {
                        try {
                          const raw = await readFile(projectName, selectedVersion!, selectedFile);
                          const blob = new Blob([raw.content], { type: raw.mimeType || 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          window.open(url, '_blank');
                          setTimeout(() => URL.revokeObjectURL(url), 60000);
                        } catch {
                          // silent
                        }
                      }}
                      style={{
                        background: 'none',
                        border: '1px solid #d1d5db',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: '0.6875rem',
                        cursor: 'pointer',
                        color: '#374151',
                      }}
                    >
                      Raw
                    </button>
                  )}
                </div>
                <div
                  style={{
                    flex: 1,
                    padding: 12,
                    overflow: 'auto',
                    minHeight: 120,
                    maxHeight: 400,
                  }}
                >
                  {fileLoading && (
                    <div style={{ color: '#9ca3af', fontSize: '0.8125rem' }}>Loading file...</div>
                  )}

                  {!fileLoading && !selectedFile && (
                    <div style={{ color: '#9ca3af', fontSize: '0.875rem', textAlign: 'center', paddingTop: 32 }}>
                      Select a file to preview
                    </div>
                  )}

                  {!fileLoading && selectedFile && fileContent !== null && (
                    <pre
                      style={{
                        margin: 0,
                        fontSize: '0.75rem',
                        fontFamily: "'Courier New', Courier, monospace",
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        color: '#1f2937',
                      }}
                    >
                      {fileContent}
                    </pre>
                  )}

                  {!fileLoading && selectedFile && fileContent === null && fileMimeType === null && !isTextFile(selectedFile) && (
                    <div style={{ color: '#9ca3af', fontSize: '0.875rem', textAlign: 'center', paddingTop: 32 }}>
                      <div style={{ fontSize: '2rem', marginBottom: 8 }}>📎</div>
                      <div>Binary file &mdash; metadata only</div>
                      <div style={{ fontSize: '0.75rem', marginTop: 4, color: '#6b7280' }}>
                        {selectedFile}
                      </div>
                    </div>
                  )}

                  {!fileLoading && selectedFile && fileContent === null && fileMimeType !== null && (
                    <div style={{ color: '#9ca3af', fontSize: '0.875rem', textAlign: 'center', paddingTop: 32 }}>
                      <div style={{ fontSize: '2rem', marginBottom: 8 }}>📄</div>
                      <div>File too large to preview (&gt;500 KB)</div>
                      <div style={{ fontSize: '0.75rem', marginTop: 4, color: '#6b7280' }}>
                        {selectedFile}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Run New Iteration */}
      <div
        style={{
          marginTop: 20,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: 8, color: '#374151' }}>
          Run New Iteration
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what changes to make in this iteration..."
            rows={2}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.8125rem',
              fontFamily: 'inherit',
              resize: 'vertical',
              lineHeight: 1.4,
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleRun();
              }
            }}
          />
          <button
            onClick={handleRun}
            disabled={runLoading || !prompt.trim()}
            style={{
              padding: '8px 20px',
              backgroundColor: runLoading || !prompt.trim() ? '#d1d5db' : '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: '0.8125rem',
              fontWeight: 600,
              cursor: runLoading || !prompt.trim() ? 'not-allowed' : 'pointer',
              alignSelf: 'flex-end',
              whiteSpace: 'nowrap',
            }}
          >
            {runLoading ? 'Running...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
