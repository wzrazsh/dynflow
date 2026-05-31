// Core definition types
export interface WorkflowDefinition {
  name: string;
  phases: PhaseDefinition[];
}

export interface WorkflowScript {
  name: string;
  script: string;
}

export interface PhaseDefinition {
  name: string;
  agents: AgentDefinition[];
  maxConcurrency?: number;
}

export interface AgentDefinition {
  name: string;
  prompt?: string;
  /** Reference to a predefined agent in the agent registry */
  agentId?: string;
  model?: string;
  timeoutMs?: number;
}

// Run types (runtime instances)
export interface WorkflowRun {
  id: string;
  name: string;
  status: WorkflowStatus;
  phases: PhaseRun[];
  createdAt: string;
  updatedAt: string;
}

export interface PhaseRun {
  id: string;
  name: string;
  status: PhaseStatus;
  agents: AgentRun[];
  order: number;
}

export interface AgentRun {
  id: string;
  name: string;
  status: AgentStatus;
  prompt: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  timeoutMs?: number;
  files?: string[];
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;
}

// Status enums as string unions
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export type AgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

// SSE types
export interface SSEEvent {
  type: SSEEventType;
  workflowId: string;
  phaseId?: string;
  agentId?: string;
  status?: string;
  timestamp: string;
  data?: unknown;
}

export type SSEEventType =
  | 'workflow_started'
  | 'workflow_paused'
  | 'workflow_resumed'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_stopped'
  | 'phase_started'
  | 'phase_completed'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_timeout'
  | 'heartbeat';

// API types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

export interface WorkflowListResponse {
  success: boolean;
  data: WorkflowRun[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

// Workflow Template types
export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  script: string;
  currentVersion: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  script: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface CreateTemplateRequest {
  name: string;
  description?: string;
  script: string;
  tags?: string[];
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  script?: string;
  tags?: string[];
}

export interface CompareVersionsRequest {
  from: number;
  to: number;
}

export interface RollbackVersionRequest {
  version: number;
}

export interface CloneWorkflowRequest {
  name: string;
  description?: string;
  tags?: string[];
}

export interface ImportTemplateRequest {
  content: string;
}

// Project management types
export interface ProjectMeta {
  projectName: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  projectName: string;
  versions: VersionMeta[];
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  version: number;
  status: 'running' | 'completed' | 'failed';
  fileCount: number;
  totalSize: number;
  files: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface RunResponse {
  version: number;
  status: string;
}

export interface FileReadResponse {
  content: string;
  mimeType: string;
}
