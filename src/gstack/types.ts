/**
 * gstack skill preamble tier (controls auto-setup level)
 * - 1: minimum (browse/root skills)
 * - 2: medium
 * - 3: high (plan-ceo-review)
 * - 4: complete (ship, qa)
 */
export type GstackPreambleTier = 1 | 2 | 3 | 4;

/**
 * Frontmatter metadata from a gstack SKILL.md
 */
export interface GstackSkillFrontmatter {
  name: string;
  'preamble-tier': GstackPreambleTier;
  version: string;
  description: string;
  'allowed-tools': string[];
  triggers: string[];
  interactive?: boolean;
  'benefits-from'?: string[];
}

/**
 * Skill reference summary extracted from SKILL.md (no executable instructions)
 */
export interface GstackSkillReference {
  name: string;
  description: string | undefined;
  triggers: string[];
  whenToInvoke: string | undefined;
  importantRules: string | undefined;
}

/**
 * Configuration for loading a gstack skill
 */
export interface GstackSkillConfig {
  skillName: string;
  fallbackPrompt: string;
  repoDir?: string;
  skillsDir?: string;
}
