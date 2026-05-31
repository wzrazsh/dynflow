/**
 * Predefined agent type definitions for the multi-agent orchestration system.
 *
 * A PredefinedAgent is a fully-configured agent that can be referenced by
 * agentId in a workflow, as opposed to a dynamically defined agent with
 * an inline prompt.
 */

/**
 * A predefined agent entry that can be referenced by `agentId` in workflow
 * definitions. Predefined agents have a fixed system prompt and a set of
 * available skills they can invoke.
 */
export interface PredefinedAgent {
  /** Unique identifier for this predefined agent */
  id: string;
  /** The role this agent fulfills (links to AgentRole) */
  roleId: string;
  /** Human-readable agent name */
  name: string;
  /** Description of the agent's capabilities */
  description: string;
  /** The system prompt that defines this agent's behavior */
  systemPrompt: string;
  /** List of skill IDs this agent can use */
  availableSkills: string[];
}
