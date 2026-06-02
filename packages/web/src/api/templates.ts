import { get } from './client';

export interface TemplateUsage {
  id: string;
  name: string;
  description: string;
  workflowCount: number;
}

export function fetchTemplates(): Promise<{ success: boolean; data: TemplateUsage[] }> {
  return get<{ success: boolean; data: TemplateUsage[] }>('/templates/used-in-workflows');
}
