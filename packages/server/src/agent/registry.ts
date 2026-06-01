/**
 * Agent Registry — hierarchical query layer over the domain/source/role/agent tables.
 *
 * Provides a clean API for browsing the predefined agent hierarchy:
 *   Domain → AgentSource → AgentRole → PredefinedAgent
 *
 * Delegates CRUD to the repository layer where possible. For update operations
 * (not yet in the repository), it uses the underlying SQLite connection directly,
 * then re-reads via repository get* functions.
 */

import { getDb, withRetry } from '../db/connection.js';
import * as repo from '../db/repository.js';
import type {
  Domain,
  AgentSource,
  AgentRole,
  PredefinedAgent,
} from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Import type
// ---------------------------------------------------------------------------

/**
 * JSON structure accepted by `importFromJSON`.
 *
 * Parent references can use either the parent's UUID (`domainId` / `sourceId` /
 * `roleId`) or the parent's human-readable name (`domainName` / `sourceName` /
 * `roleName`). Name-based lookups resolve against items already in the
 * database, including those imported in the same call (so items are processed
 * in the order they appear: domains first, then sources, then roles, then
 * agents).
 */
export interface RegistryJSON {
  domains?: Array<{
    name: string;
    description: string;
    icon?: string;
  }>;
  sources?: Array<{
    domainId?: string;
    domainName?: string;
    name: string;
    url: string;
    description: string;
  }>;
  roles?: Array<{
    sourceId?: string;
    sourceName?: string;
    name: string;
    description: string;
    tier?: number;
  }>;
  agents?: Array<{
    roleId?: string;
    roleName?: string;
    name: string;
    description: string;
    systemPrompt: string;
    availableSkills?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Domain operations
// ---------------------------------------------------------------------------

/**
 * List all domains in alphabetical order.
 */
export function getDomains(): Domain[] {
  return repo.getAllDomains();
}

/**
 * Create a new domain. Returns the created entity with its generated ID.
 */
export function addDomain(data: {
  name: string;
  description: string;
  icon?: string;
}): Domain {
  return repo.createDomain(data);
}

/**
 * Partial-update a domain by ID.
 * Returns the updated Domain, or `undefined` if the ID does not exist.
 */
export function updateDomain(
  id: string,
  data: Partial<Pick<Domain, 'name' | 'description' | 'icon'>>,
): Domain | undefined {
  const existing = repo.getDomain(id);
  if (!existing) return undefined;

  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) {
    setClauses.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    setClauses.push('description = ?');
    values.push(data.description);
  }
  if (data.icon !== undefined) {
    setClauses.push('icon = ?');
    values.push(data.icon);
  }

  if (setClauses.length > 0) {
    values.push(id);
    withRetry(() =>
      db
        .prepare(`UPDATE domains SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values),
    );
  }

  return repo.getDomain(id);
}

/**
 * Delete a domain by ID.
 * Returns `true` if the domain existed and was deleted, `false` otherwise.
 */
export function deleteDomain(id: string): boolean {
  if (!repo.getDomain(id)) return false;
  repo.deleteDomain(id);
  return true;
}

// ---------------------------------------------------------------------------
// Agent source operations
// ---------------------------------------------------------------------------

/**
 * List all agent sources belonging to a domain, ordered alphabetically.
 */
export function getSourcesByDomain(domainId: string): AgentSource[] {
  return repo.getSourcesByDomain(domainId);
}

/**
 * Create a new agent source under a domain.
 */
export function addSource(data: {
  domainId: string;
  name: string;
  url: string;
  description: string;
}): AgentSource {
  return repo.createAgentSource(data);
}

/**
 * Partial-update an agent source by ID.
 * Returns the updated AgentSource, or `undefined` if the ID does not exist.
 */
export function updateSource(
  id: string,
  data: Partial<Pick<AgentSource, 'domainId' | 'name' | 'url' | 'description'>>,
): AgentSource | undefined {
  if (!repo.getAgentSource(id)) return undefined;

  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (data.domainId !== undefined) {
    setClauses.push('domain_id = ?');
    values.push(data.domainId);
  }
  if (data.name !== undefined) {
    setClauses.push('name = ?');
    values.push(data.name);
  }
  if (data.url !== undefined) {
    setClauses.push('url = ?');
    values.push(data.url);
  }
  if (data.description !== undefined) {
    setClauses.push('description = ?');
    values.push(data.description);
  }

  if (setClauses.length > 0) {
    values.push(id);
    withRetry(() =>
      db
        .prepare(
          `UPDATE agent_sources SET ${setClauses.join(', ')} WHERE id = ?`,
        )
        .run(...values),
    );
  }

  return repo.getAgentSource(id);
}

/**
 * Delete an agent source by ID.
 * Returns `true` if the source existed and was deleted, `false` otherwise.
 */
export function deleteSource(id: string): boolean {
  if (!repo.getAgentSource(id)) return false;
  repo.deleteAgentSource(id);
  return true;
}

// ---------------------------------------------------------------------------
// Agent role operations
// ---------------------------------------------------------------------------

/**
 * List all agent roles belonging to a source, ordered by tier then name.
 */
export function getRolesBySource(sourceId: string): AgentRole[] {
  return repo.getRolesBySource(sourceId);
}

/**
 * Create a new agent role under a source.
 */
export function addRole(data: {
  sourceId: string;
  name: string;
  description: string;
  tier?: number;
}): AgentRole {
  return repo.createAgentRole(data);
}

/**
 * Partial-update an agent role by ID.
 * Returns the updated AgentRole, or `undefined` if the ID does not exist.
 */
export function updateRole(
  id: string,
  data: Partial<Pick<AgentRole, 'sourceId' | 'name' | 'description' | 'tier'>>,
): AgentRole | undefined {
  if (!repo.getAgentRole(id)) return undefined;

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
  if (data.tier !== undefined) {
    setClauses.push('tier = ?');
    values.push(data.tier);
  }

  if (setClauses.length > 0) {
    values.push(id);
    withRetry(() =>
      db
        .prepare(`UPDATE agent_roles SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values),
    );
  }

  return repo.getAgentRole(id);
}

/**
 * Delete an agent role by ID.
 * Returns `true` if the role existed and was deleted, `false` otherwise.
 */
export function deleteRole(id: string): boolean {
  if (!repo.getAgentRole(id)) return false;
  repo.deleteAgentRole(id);
  return true;
}

// ---------------------------------------------------------------------------
// Predefined agent operations
// ---------------------------------------------------------------------------

/**
 * List all predefined agents belonging to a role, ordered alphabetically.
 */
export function getAgentsByRole(roleId: string): PredefinedAgent[] {
  return repo.getAgentsByRole(roleId);
}

/**
 * Create a new predefined agent under a role.
 */
export function addAgent(data: {
  roleId: string;
  name: string;
  description: string;
  systemPrompt: string;
  availableSkills?: string[];
}): PredefinedAgent {
  return repo.createPredefinedAgent(data);
}

/**
 * Partial-update a predefined agent by ID.
 * Returns the updated PredefinedAgent, or `undefined` if the ID does not exist.
 */
export function updateAgent(
  id: string,
  data: Partial<
    Pick<PredefinedAgent, 'roleId' | 'name' | 'description' | 'systemPrompt' | 'availableSkills'>
  >,
): PredefinedAgent | undefined {
  if (!repo.getPredefinedAgent(id)) return undefined;

  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (data.roleId !== undefined) {
    setClauses.push('role_id = ?');
    values.push(data.roleId);
  }
  if (data.name !== undefined) {
    setClauses.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    setClauses.push('description = ?');
    values.push(data.description);
  }
  if (data.systemPrompt !== undefined) {
    setClauses.push('system_prompt = ?');
    values.push(data.systemPrompt);
  }
  if (data.availableSkills !== undefined) {
    setClauses.push('available_skills = ?');
    values.push(JSON.stringify(data.availableSkills));
  }

  if (setClauses.length > 0) {
    values.push(id);
    withRetry(() =>
      db
        .prepare(
          `UPDATE predefined_agents SET ${setClauses.join(', ')} WHERE id = ?`,
        )
        .run(...values),
    );
  }

  return repo.getPredefinedAgent(id);
}

/**
 * Delete a predefined agent by ID.
 * Returns `true` if the agent existed and was deleted, `false` otherwise.
 */
export function deleteAgent(id: string): boolean {
  if (!repo.getPredefinedAgent(id)) return false;
  repo.deletePredefinedAgent(id);
  return true;
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

/**
 * Import a complete registry tree from a JSON structure.
 *
 * Items are processed in hierarchical order (domains → sources → roles → agents).
 * Parent-child references can use UUIDs (`domainId`, `sourceId`, `roleId`) or
 * human-readable names (`domainName`, `sourceName`, `roleName`) which are
 * resolved against entities already in the database (including those just
 * imported).
 *
 * @returns Counts of created entities.
 * @throws If a name-based parent reference cannot be resolved.
 */
export function importFromJSON(
  json: RegistryJSON,
): { domains: number; sources: number; roles: number; agents: number } {
  const nameToDomainId = new Map<string, string>();
  const nameToSourceId = new Map<string, string>();
  const nameToRoleId = new Map<string, string>();

  let domainCount = 0;
  let sourceCount = 0;
  let roleCount = 0;
  let agentCount = 0;

  // 1. Domains
  if (json.domains) {
    for (const d of json.domains) {
      const domain = addDomain({
        name: d.name,
        description: d.description,
        icon: d.icon,
      });
      nameToDomainId.set(domain.name, domain.id);
      domainCount++;
    }
  }

  // 2. Sources
  if (json.sources) {
    for (const s of json.sources) {
      const domainId =
        s.domainId ??
        (s.domainName ? resolveName(s.domainName, nameToDomainId, 'Domain') : undefined);
      if (!domainId) {
        throw new Error(
          `Import error: source '${s.name}' requires a valid domainId or domainName`,
        );
      }
      const source = addSource({
        domainId,
        name: s.name,
        url: s.url,
        description: s.description,
      });
      nameToSourceId.set(source.name, source.id);
      sourceCount++;
    }
  }

  // 3. Roles
  if (json.roles) {
    for (const r of json.roles) {
      const sourceId =
        r.sourceId ??
        (r.sourceName ? resolveName(r.sourceName, nameToSourceId, 'Source') : undefined);
      if (!sourceId) {
        throw new Error(
          `Import error: role '${r.name}' requires a valid sourceId or sourceName`,
        );
      }
      const role = addRole({
        sourceId,
        name: r.name,
        description: r.description,
        tier: r.tier,
      });
      nameToRoleId.set(role.name, role.id);
      roleCount++;
    }
  }

  // 4. Agents
  if (json.agents) {
    for (const a of json.agents) {
      const roleId =
        a.roleId ??
        (a.roleName ? resolveName(a.roleName, nameToRoleId, 'Role') : undefined);
      if (!roleId) {
        throw new Error(
          `Import error: agent '${a.name}' requires a valid roleId or roleName`,
        );
      }
      addAgent({
        roleId,
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        availableSkills: a.availableSkills,
      });
      agentCount++;
    }
  }

  return {
    domains: domainCount,
    sources: sourceCount,
    roles: roleCount,
    agents: agentCount,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up a name in the given map, throwing a descriptive error if not found.
 */
function resolveName(
  name: string,
  map: Map<string, string>,
  entityType: string,
): string {
  const id = map.get(name);
  if (!id) {
    throw new Error(
      `Import error: ${entityType} '${name}' not found. ` +
        `Make sure it is defined earlier in the import data or already exists in the database.`,
    );
  }
  return id;
}
