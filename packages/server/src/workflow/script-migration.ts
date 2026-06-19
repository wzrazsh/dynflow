import type { WorkflowDefinition } from '@dynflow/shared';
import { executeScript } from '../sandbox/isolated-runtime.js';
import { validateDynamicScript } from './dynamic-script-engine.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

export function definitionToDynamicScript(
  definition: WorkflowDefinition,
): string {
  const lines = [`workflow(${quote(definition.name)}, async () => {`];
  definition.phases.forEach((phase, phaseIndex) => {
    const phaseKey = `phase:${phaseIndex}:${phase.name}`;
    lines.push(`  await phase(${quote(phaseKey)}, async () => {`);
    lines.push('    await parallel([');
    phase.agents.forEach((agent, agentIndex) => {
      lines.push('      {');
      lines.push(
        `        id: ${quote(`agent:${phaseIndex}:${agentIndex}:${agent.name}`)},`,
      );
      lines.push(
        `        prompt: ${quote(agent.prompt ?? `Run predefined agent ${agent.agentId ?? agent.name}`)},`,
      );
      if (agent.model) lines.push(`        model: ${quote(agent.model)},`);
      if (agent.timeoutMs !== undefined) {
        lines.push(`        timeoutMs: ${agent.timeoutMs},`);
      }
      lines.push('      },');
    });
    lines.push(
      `    ], item => agent(item.id, { ...item, mode: "read" }), { concurrency: ${phase.maxConcurrency ?? 16} });`,
    );
    lines.push('  });');
  });
  lines.push('});');
  return lines.join('\n');
}

export async function normalizeWorkflowScript(
  script: string,
  fallbackName: string,
): Promise<
  | { success: true; script: string; migrated: boolean; definition: WorkflowDefinition }
  | { success: false; error: string; line?: number }
> {
  if (/\bworkflow\s*\(/.test(script)) {
    const dynamic = await validateDynamicScript(script, {
      timeoutMs: 2_000,
      memoryLimitMb: 128,
    });
    if (!dynamic.valid) {
      return { success: false, error: dynamic.error };
    }
    return {
      success: true,
      script,
      migrated: false,
      definition: { name: fallbackName, phases: [] },
    };
  }

  const legacy = await executeScript(script, {
    timeoutMs: 30_000,
    memoryLimitMb: 128,
  });
  if (!legacy.success || !legacy.definition) {
    return {
      success: false,
      error: legacy.error || 'Invalid workflow script',
      line: legacy.line,
    };
  }
  legacy.definition.name = fallbackName;
  return {
    success: true,
    script: definitionToDynamicScript(legacy.definition),
    migrated: true,
    definition: legacy.definition,
  };
}
