// ---------------------------------------------------------------------------
// Project Service Types
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  projectName: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  version: string;
  status: 'running' | 'completed' | 'failed';
  fileCount: number;
  totalSize: number;
  files: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface FileEntry {
  path: string;
  size: number;
}
