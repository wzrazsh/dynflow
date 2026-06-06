export interface ParsedPiOutput {
  success: boolean;
  lastText: string;
  allMessages: unknown[];
  toolCalls: number;
  error?: string;
}

interface PiEvent {
  type: string;
  messages?: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function parsePiJsonLines(rawOutput: string): ParsedPiOutput {
  const events: PiEvent[] = [];
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      /* skip non-JSON lines */
    }
  }

  const agentEnd = events.find((e) => e.type === 'agent_end');
  if (!agentEnd) {
    return {
      success: false,
      lastText: '',
      allMessages: [],
      toolCalls: 0,
      error: 'Pi 输出中未找到 agent_end 事件',
    };
  }

  const messages = agentEnd.messages ?? [];
  const lastText = extractLastAssistantText(messages);
  const toolCalls = events.filter((e) => e.type === 'tool_execution_start').length;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const stopReason = lastAssistant?.stopReason;
  const success = stopReason !== 'error' && stopReason !== 'aborted';
  const error =
    stopReason === 'error' || stopReason === 'aborted'
      ? lastAssistant?.errorMessage ?? `stopReason=${stopReason}`
      : undefined;

  return { success, lastText, allMessages: messages, toolCalls, error };
}

function extractLastAssistantText(
  messages: Array<{ role: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const textBlock = (m.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === 'text',
      );
      if (textBlock?.text) return textBlock.text;
    }
  }
  return '';
}
