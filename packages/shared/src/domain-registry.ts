/**
 * Domain/Source/Agent type definitions for the multi-agent orchestration system.
 *
 * Agent hierarchy: Domain → Source → Role → Agent (max 10 choices per level)
 *
 * - Domain: A broad problem domain (e.g. "Code Analysis", "Web Development")
 * - AgentSource: A source/provider of agents (e.g. "GitHub Trending", "OpenAI GPT Store")
 * - AgentRole: A specific role/function an agent can perform (e.g. "Code Reviewer", "Bug Finder")
 */

/**
 * A broad problem domain that agents can operate in.
 * Examples: "Code Analysis", "Web Development", "Data Science"
 */
export interface Domain {
  /** Unique identifier for the domain */
  id: string;
  /** Human-readable domain name */
  name: string;
  /** Description of what this domain covers */
  description: string;
  /** Optional icon identifier for UI display */
  icon?: string;
}

/**
 * A source/provider from which agents are discovered.
 * Examples: "GitHub Trending", "OpenAI GPT Store", "Hugging Face"
 */
export interface AgentSource {
  /** Unique identifier for this source */
  id: string;
  /** The domain this source belongs to */
  domainId: string;
  /** Human-readable source name */
  name: string;
  /** URL to the source (e.g. GitHub topic URL, GPT Store link) */
  url: string;
  /** Description of what agents this source provides */
  description: string;
}

/**
 * A specific role or function that a predefined agent can perform.
 * Examples: "Code Reviewer", "Bug Finder", "Documentation Writer"
 */
export interface AgentRole {
  /** Unique identifier for this role */
  id: string;
  /** The agent source this role belongs to */
  sourceId: string;
  /** Human-readable role name */
  name: string;
  /** Description of what this role does */
  description: string;
  /** Tier/priority level for ranking (lower = higher priority) */
  tier: number;
}
