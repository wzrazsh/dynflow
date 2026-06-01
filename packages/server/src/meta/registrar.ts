/**
 * Project registrar for the meta-workflow system.
 *
 * Registers extracted agents and skills into the system registries by
 * creating the Domain → AgentSource → Role → Agent + Skill hierarchy.
 *
 * Flow:
 *   1. Create or find a Domain for the project
 *   2. Create an AgentSource with the project URL
 *   3. Process skills (create or skip duplicates)
 *   4. Process agents (create role + predefined agent, link to skills)
 */

import {
  createDomain,
  getAllDomains,
  createAgentSource,
  getSourcesByDomain,
  createAgentRole,
  getRolesBySource,
  getAgentsByRole,
  createPredefinedAgent,
  createSkill,
  getSkillsBySource,
  addAgentSkill,
} from '../db/repository.js';
import type { ExtractedAgent, ExtractedSkill } from './extractor.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RegistrationResult {
  /** Whether registration completed (true even with warnings) */
  success: boolean;
  /** The created or reused domain ID */
  domainId?: string;
  /** The created or reused source ID */
  sourceId?: string;
  /** Number of new roles created */
  rolesCount: number;
  /** Number of agents processed */
  agentsCount: number;
  /** Number of skills processed */
  skillsCount: number;
  /** Non-critical warnings collected during registration */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a project's extracted agents and skills into the system registries.
 *
 * Creates or reuses existing Domain, AgentSource, Role, PredefinedAgent,
 * and Skill entries.  Warnings are collected for duplicate names and
 * missing skill references — they do not cause the registration to fail.
 *
 * Skills are processed **before** agents so that agent-to-skill linking
 * can resolve skill IDs from the same registration pass.
 */
export function registerProject(
  projectName: string,
  projectUrl: string,
  agents: ExtractedAgent[],
  skills: ExtractedSkill[],
): RegistrationResult {
  const warnings: string[] = [];

  // -----------------------------------------------------------------------
  // 1. Domain
  // -----------------------------------------------------------------------
  const existingDomains = getAllDomains();
  let domain = existingDomains.find((d) => d.name === projectName);

  if (!domain) {
    domain = createDomain({
      name: projectName,
      description: `Agents and skills from ${projectName}`,
    });
  } else {
    warnings.push(
      `Domain "${projectName}" already exists, reusing existing domain`,
    );
  }

  // -----------------------------------------------------------------------
  // 2. AgentSource
  // -----------------------------------------------------------------------
  const sources = getSourcesByDomain(domain.id);
  let source = sources.find((s) => s.url === projectUrl);

  if (!source) {
    source = createAgentSource({
      domainId: domain.id,
      name: projectName,
      url: projectUrl,
      description: `Source for ${projectName}`,
    });
  } else {
    warnings.push(
      `Source "${projectUrl}" already exists, reusing existing source`,
    );
  }

  // -----------------------------------------------------------------------
  // 3. Skills (processed first so agents can reference them)
  // -----------------------------------------------------------------------
  const skillNameToId = new Map<string, string>();

  for (const skill of skills) {
    const existingSkills = getSkillsBySource(source.id);
    const existing = existingSkills.find((s) => s.name === skill.name);

    if (!existing) {
      const created = createSkill({
        sourceId: source.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        parameters: skill.parameters,
        inputSchema: skill.inputSchema,
        outputSchema: skill.outputSchema,
      });
      skillNameToId.set(skill.name, created.id);
    } else {
      skillNameToId.set(skill.name, existing.id);
      warnings.push(
        `Skill "${skill.name}" already exists, reusing existing skill`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 4. Agents
  // -----------------------------------------------------------------------
  let rolesCount = 0;

  for (const agent of agents) {
    // --- Role (use agent name as role name) --------------------------------
    const existingRoles = getRolesBySource(source.id);
    let role = existingRoles.find((r) => r.name === agent.name);

    if (!role) {
      role = createAgentRole({
        sourceId: source.id,
        name: agent.name,
        description: agent.description,
      });
      rolesCount++;
    } else {
      warnings.push(
        `Role "${agent.name}" already exists, reusing existing role`,
      );
    }

    // --- PredefinedAgent ----------------------------------------------------
    const existingAgents = getAgentsByRole(role.id);
    const existingAgent = existingAgents.find((a) => a.name === agent.name);

    if (existingAgent) {
      warnings.push(
        `Predefined agent "${agent.name}" already exists, skipping`,
      );
      continue;
    }

    const predefinedAgent = createPredefinedAgent({
      roleId: role.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      availableSkills: agent.availableSkills,
    });

    // --- Agent-skill linking -------------------------------------------------
    for (const skillName of agent.availableSkills) {
      const skillId = skillNameToId.get(skillName);
      if (skillId) {
        addAgentSkill(predefinedAgent.id, skillId);
      } else {
        warnings.push(
          `Skill "${skillName}" referenced by agent "${agent.name}" was not found`,
        );
      }
    }
  }

  return {
    success: true,
    domainId: domain.id,
    sourceId: source.id,
    rolesCount,
    agentsCount: agents.length,
    skillsCount: skills.length,
    warnings,
  };
}
