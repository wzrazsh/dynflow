import type { AgentResult, TokenUsage } from '../types/agent.js';

/**
 * Tracks token usage across agents, phases, and the entire workflow.
 */
export class TokenTracker {
  private perAgent: Map<string, TokenUsage> = new Map();
  private perPhase: Map<string, TokenUsage> = new Map();
  private total: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  /**
   * Record token usage from an agent result.
   */
  record(result: AgentResult): void {
    // Per-agent
    const agentKey = `${result.phaseName}:${result.id}`;
    this.perAgent.set(agentKey, { ...result.tokenUsage });

    // Per-phase (accumulate)
    const phaseKey = result.phaseName;
    const current = this.perPhase.get(phaseKey) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.perPhase.set(phaseKey, {
      promptTokens: current.promptTokens + result.tokenUsage.promptTokens,
      completionTokens: current.completionTokens + result.tokenUsage.completionTokens,
      totalTokens: current.totalTokens + result.tokenUsage.totalTokens,
    });

    // Total (accumulate)
    this.total.promptTokens += result.tokenUsage.promptTokens;
    this.total.completionTokens += result.tokenUsage.completionTokens;
    this.total.totalTokens += result.tokenUsage.totalTokens;
  }

  /**
   * Get token usage per agent (phase:agentId → usage).
   */
  getPerAgent(): Map<string, TokenUsage> {
    return new Map(this.perAgent);
  }

  /**
   * Get token usage per phase.
   */
  getPerPhase(): Map<string, TokenUsage> {
    return new Map(this.perPhase);
  }

  /**
   * Get total token usage.
   */
  getTotal(): TokenUsage {
    return { ...this.total };
  }

  /**
   * Reset all counters.
   */
  reset(): void {
    this.perAgent.clear();
    this.perPhase.clear();
    this.total = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}
