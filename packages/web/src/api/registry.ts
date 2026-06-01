import { get } from './client';
import type { Domain, AgentSource, AgentRole, PredefinedAgent } from '@dynflow/shared';

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface ListResponse<T> {
  success: boolean;
  data: T[];
}

export function fetchDomains(): Promise<PaginatedResponse<Domain>> {
  return get<PaginatedResponse<Domain>>('/domains');
}

export function fetchAgentSources(domainId: string): Promise<ListResponse<AgentSource>> {
  return get<ListResponse<AgentSource>>(`/domains/${domainId}/agent-sources`);
}

export function fetchRoles(sourceId: string): Promise<ListResponse<AgentRole>> {
  return get<ListResponse<AgentRole>>(`/agent-sources/${sourceId}/roles`);
}

export function fetchAgentsByRole(roleId: string): Promise<ListResponse<PredefinedAgent>> {
  return get<ListResponse<PredefinedAgent>>(`/predefined-agents/roles/${roleId}/agents`);
}
