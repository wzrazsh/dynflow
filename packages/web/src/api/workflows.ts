import { get, post } from './client';
import type { WorkflowListResponse, WorkflowRun, ApiResponse, WorkflowDefinition } from '@dynflow/shared';

export function fetchWorkflows(page = 1, pageSize = 20): Promise<WorkflowListResponse> {
  return get<WorkflowListResponse>(`/workflows?page=${page}&pageSize=${pageSize}`);
}

export function fetchWorkflow(id: string): Promise<ApiResponse<WorkflowRun>> {
  return get<ApiResponse<WorkflowRun>>(`/workflows/${id}`);
}

export function createWorkflow(name: string, script: string): Promise<ApiResponse<WorkflowRun>> {
  return post<ApiResponse<WorkflowRun>>('/workflows', { name, script });
}

export function controlWorkflow(id: string, action: 'start' | 'pause' | 'resume' | 'stop'): Promise<ApiResponse<{ status: string }>> {
  return post<ApiResponse<{ status: string }>>(`/workflows/${id}/${action}`, {});
}

export interface OrchestrateResponse {
  success: boolean;
  data?: WorkflowDefinition;
  error?: string;
  rawResponse?: string;
}

export function orchestrateWorkflow(
  userRequest: string,
  options?: {
    domains?: any[];
    sources?: any[];
    roles?: any[];
    agents?: any[];
    skills?: any[];
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  },
): Promise<OrchestrateResponse> {
  return post<OrchestrateResponse>('/orchestrate', {
    userRequest,
    domains: options?.domains || [],
    sources: options?.sources || [],
    roles: options?.roles || [],
    agents: options?.agents || [],
    skills: options?.skills || [],
    apiKey: options?.apiKey,
    baseUrl: options?.baseUrl,
    model: options?.model,
  });
}
