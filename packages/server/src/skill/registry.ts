import { getDb, withRetry } from '../db/connection.js';
import * as repo from '../db/repository.js';
import type { Skill, SkillCategory, SkillParameter } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw DB row (Record<string, unknown>) to a Skill object.
 * Mirrors the row-mapping in repository.ts for queries not covered by repo.
 */
function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as Skill['category'],
    parameters: JSON.parse(row.parameters as string) as SkillParameter[],
    inputSchema: row.input_schema
      ? (JSON.parse(row.input_schema as string) as Record<string, unknown>)
      : undefined,
    outputSchema: row.output_schema
      ? (JSON.parse(row.output_schema as string) as Record<string, unknown>)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Return all skills in the registry, ordered by name.
 */
export function getSkills(): Skill[] {
  const db = getDb();
  const rows = withRetry(() =>
    db.prepare('SELECT * FROM skills ORDER BY name ASC').all(),
  ) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

/**
 * Return skills that belong to a specific agent source.
 * Delegates to the repository layer.
 */
export function getSkillsBySource(sourceId: string): Skill[] {
  return repo.getSkillsBySource(sourceId);
}

/**
 * Return skills matching a given category.
 */
export function getSkillsByCategory(category: SkillCategory): Skill[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM skills WHERE category = ? ORDER BY name ASC')
      .all(category),
  ) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

// ---------------------------------------------------------------------------
// Mutation functions
// ---------------------------------------------------------------------------

/**
 * Register a new skill.
 *
 * @param skill – all skill fields except `id` (a UUID is generated internally)
 * @returns the newly created Skill
 */
export function addSkill(skill: Omit<Skill, 'id'>): Skill {
  return repo.createSkill(skill);
}

/**
 * Partially update an existing skill.
 *
 * Only the provided fields are changed.  Returns the updated skill,
 * or `undefined` if no skill with the given `id` exists.
 */
export function updateSkill(
  id: string,
  data: Partial<Skill>,
): Skill | undefined {
  const existing = repo.getSkill(id);
  if (!existing) return undefined;

  const db = getDb();

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (data.sourceId !== undefined) {
    setClauses.push('source_id = ?');
    values.push(data.sourceId);
  }
  if (data.name !== undefined) {
    setClauses.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    setClauses.push('description = ?');
    values.push(data.description);
  }
  if (data.category !== undefined) {
    setClauses.push('category = ?');
    values.push(data.category);
  }
  if (data.parameters !== undefined) {
    setClauses.push('parameters = ?');
    values.push(JSON.stringify(data.parameters));
  }
  if (data.inputSchema !== undefined) {
    setClauses.push('input_schema = ?');
    values.push(JSON.stringify(data.inputSchema));
  }
  if (data.outputSchema !== undefined) {
    setClauses.push('output_schema = ?');
    values.push(JSON.stringify(data.outputSchema));
  }

  // Nothing to update
  if (setClauses.length === 0) return existing;

  values.push(id);
  withRetry(() =>
    db
      .prepare(`UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values),
  );

  // Return the fresh row
  return repo.getSkill(id)!;
}

/**
 * Remove a skill from the registry.
 *
 * @returns `true` if the skill existed and was deleted, `false` otherwise.
 */
export function deleteSkill(id: string): boolean {
  const existing = repo.getSkill(id);
  if (!existing) return false;
  repo.deleteSkill(id);
  return true;
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

/**
 * Import an array of skills from an external JSON source.
 *
 * Each skill object receives a new UUID on insertion.
 *
 * @param json – object with a `skills` array of skill data (without IDs)
 * @returns the number of skills that were imported
 */
export function importFromJSON(json: {
  skills: Omit<Skill, 'id'>[];
}): { count: number } {
  for (const skill of json.skills) {
    repo.createSkill(skill);
  }
  return { count: json.skills.length };
}
