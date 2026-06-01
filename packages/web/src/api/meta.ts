import { post } from './client';
import type { ApiResponse } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Types mirroring the server-side meta-workflow system
// ---------------------------------------------------------------------------

export interface ScannedFile {
  path: string;
  content: string;
  size: number;
  isDefinition: boolean;
}

export interface ScanResult {
  success: boolean;
  projectName?: string;
  files?: ScannedFile[];
  error?: string;
  cleanedUp: boolean;
}

export interface ExtractedAgent {
  name: string;
  description: string;
  systemPrompt: string;
  availableSkills: string[];
  source: string;
}

export interface ExtractedSkill {
  name: string;
  description: string;
  category: string;
  parameters: { name: string; type: string; description: string; required: boolean; defaultValue?: unknown }[];
  source: string;
}

export interface ExtractionResult {
  agents: ExtractedAgent[];
  skills: ExtractedSkill[];
  warnings: string[];
}

export interface RegistrationResult {
  success: boolean;
  domainId?: string;
  sourceId?: string;
  rolesCount: number;
  agentsCount: number;
  skillsCount: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Clone a GitHub repo (shallow) and scan for agent/skill definition files.
 */
export function scanRepository(url: string): Promise<ScanResult> {
  return post<ScanResult>('/meta/scan', { url });
}

/**
 * Extract agent and skill definitions from scanned files.
 */
export function extractDefinitions(files: ScannedFile[]): Promise<ApiResponse<ExtractionResult>> {
  return post<ApiResponse<ExtractionResult>>('/meta/extract', { files });
}

/**
 * Register extracted agents and skills into the system database.
 */
export function registerProject(
  projectName: string,
  projectUrl: string,
  agents: ExtractedAgent[],
  skills: ExtractedSkill[],
): Promise<RegistrationResult> {
  return post<RegistrationResult>('/meta/register', {
    projectName,
    projectUrl,
    agents,
    skills,
  });
}
