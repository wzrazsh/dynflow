import { get } from './client';
import type { ApiResponse, Skill, AgentSource } from '@dynflow/shared';

export interface SkillsQuery {
  sourceId?: string;
  category?: string;
  search?: string;
}

export function fetchSkills(query?: SkillsQuery): Promise<ApiResponse<Skill[]>> {
  const params = new URLSearchParams();
  if (query?.sourceId) params.set('sourceId', query.sourceId);
  if (query?.category) params.set('category', query.category);
  if (query?.search) params.set('search', query.search);
  const qs = params.toString();
  return get<ApiResponse<Skill[]>>(`/skills${qs ? `?${qs}` : ''}`);
}

export function fetchAgentSources(): Promise<ApiResponse<AgentSource[]>> {
  return get<ApiResponse<AgentSource[]>>('/agent-sources');
}
