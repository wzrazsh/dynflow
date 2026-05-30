import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AgentResult } from '../types/agent.js';

export interface CacheOptions {
  storageDir?: string;
  enabled?: boolean;
}

/**
 * Per-session result cache keyed by phaseName:agentId.
 * Optional file persistence for resume capability.
 */
export class WorkflowCache {
  private cache = new Map<string, AgentResult>();
  private storagePath?: string;

  constructor(
    private sessionId: string,
    private options: CacheOptions = {}
  ) {
    if (options.storageDir) {
      this.storagePath = join(options.storageDir, `${this.sessionId}-cache.json`);
    }
  }

  private key(phaseName: string, agentId: string): string {
    return `${phaseName}:${agentId}`;
  }

  /**
   * Get a cached result.
   */
  get(phaseName: string, agentId: string): AgentResult | undefined {
    if (this.options.enabled === false) return undefined;
    return this.cache.get(this.key(phaseName, agentId));
  }

  /**
   * Store a result in cache.
   */
  set(phaseName: string, agentId: string, result: AgentResult): void {
    if (this.options.enabled === false) return;
    this.cache.set(this.key(phaseName, agentId), result);
  }

  /**
   * Check if a result is cached.
   */
  has(phaseName: string, agentId: string): boolean {
    if (this.options.enabled === false) return false;
    return this.cache.has(this.key(phaseName, agentId));
  }

  /**
   * Load persisted cache from disk.
   */
  async load(): Promise<void> {
    if (!this.storagePath) return;
    try {
      const data = await readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, AgentResult>;
      for (const [key, result] of Object.entries(parsed)) {
        this.cache.set(key, result);
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /**
   * Persist cache to disk.
   */
  async save(): Promise<void> {
    if (!this.storagePath) return;
    const dir = dirname(this.storagePath);
    await mkdir(dir, { recursive: true });
    const data = Object.fromEntries(this.cache);
    await writeFile(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Get all cached results.
   */
  getAll(): Map<string, AgentResult> {
    return new Map(this.cache);
  }
}
