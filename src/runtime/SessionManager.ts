import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AgentResult, TokenUsage } from '../types/agent.js';

/**
 * Persisted session state for resume capability.
 */
export interface SessionState {
  sessionId: string;
  workflowName: string;
  createdAt: number;
  updatedAt: number;
  completedPhases: string[];
  results: Record<string, Record<string, AgentResult>>;
  tokenTracker: {
    perAgent: Record<string, TokenUsage>;
    perPhase: Record<string, TokenUsage>;
    total: TokenUsage;
  };
}

/**
 * Manages session state persistence for workflow resume.
 */
export class SessionManager {
  constructor(private storageDir: string = '.wf-sessions') {}

  private getPath(sessionId: string): string {
    return join(this.storageDir, `${sessionId}.json`);
  }

  /**
   * Save session state to disk.
   */
  async save(state: SessionState): Promise<void> {
    const path = this.getPath(state.sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Load session state from disk.
   */
  async load(sessionId: string): Promise<SessionState | null> {
    try {
      const data = await readFile(this.getPath(sessionId), 'utf-8');
      return JSON.parse(data) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * List all saved session IDs.
   */
  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(this.storageDir);
      return files
        .filter(f => f.endsWith('.json') && !f.endsWith('-cache.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * Delete a session from disk.
   */
  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.getPath(sessionId));
    } catch {
      // Ignore — file doesn't exist
    }
  }

  /**
   * Convert Map-based results to serializable format.
   */
  static serializeResults(
    results: Map<string, Map<string, AgentResult>>
  ): Record<string, Record<string, AgentResult>> {
    const serialized: Record<string, Record<string, AgentResult>> = {};
    for (const [phaseName, phaseResults] of results) {
      serialized[phaseName] = {};
      for (const [agentId, result] of phaseResults) {
        serialized[phaseName][agentId] = result;
      }
    }
    return serialized;
  }

  /**
   * Deserialize results back to Map format.
   */
  static deserializeResults(
    serialized: Record<string, Record<string, AgentResult>>
  ): Map<string, Map<string, AgentResult>> {
    const results = new Map<string, Map<string, AgentResult>>();
    for (const [phaseName, agents] of Object.entries(serialized)) {
      const phaseMap = new Map<string, AgentResult>();
      for (const [agentId, result] of Object.entries(agents)) {
        phaseMap.set(agentId, result);
      }
      results.set(phaseName, phaseMap);
    }
    return results;
  }
}
