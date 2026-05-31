/**
 * Skill type definitions for the multi-agent orchestration system.
 *
 * Skills are reusable capabilities that agents can invoke during
 * workflow execution, such as code analysis, web searching, or
 * file manipulation.
 */

/**
 * Category classification for a skill.
 * Used for UI grouping and logical organization.
 */
export type SkillCategory =
  | 'development'
  | 'analysis'
  | 'research'
  | 'creative'
  | 'communication'
  | 'automation'
  | 'other';

/**
 * Parameter definition for a skill's input or output.
 * Describes what data a skill expects or produces.
 */
export interface SkillParameter {
  /** Parameter name (matches the key in the input/output object) */
  name: string;
  /** Expected data type (e.g. "string", "number", "boolean", "object") */
  type: string;
  /** Human-readable description of this parameter */
  description: string;
  /** Whether this parameter must be provided */
  required: boolean;
  /** Optional default value if not explicitly provided */
  defaultValue?: unknown;
}

/**
 * A reusable capability that agents can invoke during execution.
 * Examples: "GitHub Code Search", "Web Scraping", "File Reader"
 */
export interface Skill {
  /** Unique identifier for this skill */
  id: string;
  /** The agent source this skill originates from */
  sourceId: string;
  /** Human-readable skill name */
  name: string;
  /** Description of what this skill does */
  description: string;
  /** Category for UI grouping and organization */
  category: SkillCategory;
  /** Input parameters this skill expects */
  parameters: SkillParameter[];
  /** Optional JSON Schema describing the input shape */
  inputSchema?: Record<string, unknown>;
  /** Optional JSON Schema describing the output shape */
  outputSchema?: Record<string, unknown>;
}
