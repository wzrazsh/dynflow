/**
 * Candidate selection and filtering logic for the orchestrator.
 *
 * Every LLM-facing choice list is capped at `maxChoicesPerStep` (10) items
 * to stay within prompt token budgets and reduce decision complexity.
 *
 * Ranking logic is intentionally simple (first-N description preference) for
 * the MVP; a future upgrade can plug in embedding-based relevance scoring.
 */

import type {
  Domain,
  AgentSource,
  AgentRole,
  Skill,
  SkillCategory,
} from '@dynflow/shared';
import type { PredefinedAgent } from '@dynflow/shared';

/** Hard limit enforced across all selection methods. */
export const maxChoicesPerStep = 10;

/**
 * Clamp the requested count to the allowed maximum.
 */
function clamp(count: number | undefined): number {
  if (count === undefined || count < 1) return maxChoicesPerStep;
  return Math.min(count, maxChoicesPerStep);
}

/**
 * Simple ranking heuristic: prefer items that have a non-empty description.
 * Items WITH a description sort before items WITHOUT one. Within each group
 * the original order is preserved (stable).
 */
function ranked<T extends { description: string }>(items: T[]): T[] {
  const withDesc = items.filter((i) => i.description.length > 0);
  const withoutDesc = items.filter((i) => i.description.length === 0);
  return [...withDesc, ...withoutDesc];
}

/**
 * Filters and caps candidate lists before they reach the LLM prompt.
 *
 * Each method accepts the full collection, applies optional filtering
 * (by parent ID), sorts with a basic relevance heuristic, and clamps at
 * `maxChoicesPerStep`.
 */
export class CandidateSelector {
  /**
   * Select at most `count` domains, preferring those with descriptions.
   */
  selectDomains(all: Domain[], count?: number): Domain[] {
    const n = clamp(count);
    return ranked(all).slice(0, n);
  }

  /**
   * Select at most `count` agent sources.
   * When `domainId` is provided, only sources belonging to that domain are
   * considered.
   */
  selectSources(
    all: AgentSource[],
    domainId?: string,
    count?: number,
  ): AgentSource[] {
    const n = clamp(count);
    const filtered = domainId
      ? all.filter((s) => s.domainId === domainId)
      : all;
    return ranked(filtered).slice(0, n);
  }

  /**
   * Select at most `count` agent roles.
   * When `sourceId` is provided, only roles belonging to that source are
   * considered. Roles are ordered by tier (lower = higher priority) first,
   * then by description presence.
   */
  selectRoles(
    all: AgentRole[],
    sourceId?: string,
    count?: number,
  ): AgentRole[] {
    const n = clamp(count);
    const filtered = sourceId
      ? all.filter((r) => r.sourceId === sourceId)
      : all;
    // Sort by tier (ascending) then by description presence
    const sorted = [...filtered].sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aHasDesc = a.description.length > 0 ? 1 : 0;
      const bHasDesc = b.description.length > 0 ? 1 : 0;
      return bHasDesc - aHasDesc;
    });
    return sorted.slice(0, n);
  }

  /**
   * Select at most `count` predefined agents.
   * When `roleId` is provided, only agents with that role are considered.
   */
  selectAgents(
    all: PredefinedAgent[],
    roleId?: string,
    count?: number,
  ): PredefinedAgent[] {
    const n = clamp(count);
    const filtered = roleId
      ? all.filter((a) => a.roleId === roleId)
      : all;
    return ranked(filtered).slice(0, n);
  }

  /**
   * Select at most `count` skills.
   * When `sourceId` or `category` is provided the list is pre-filtered.
   */
  selectSkills(
    all: Skill[],
    sourceId?: string,
    category?: SkillCategory,
    count?: number,
  ): Skill[] {
    const n = clamp(count);
    let filtered = all;
    if (sourceId) {
      filtered = filtered.filter((s) => s.sourceId === sourceId);
    }
    if (category) {
      filtered = filtered.filter((s) => s.category === category);
    }
    return ranked(filtered).slice(0, n);
  }
}
