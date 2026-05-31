import { fileURLToPath } from "node:url";

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
}

export async function executeAgent(): Promise<AgentResult> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, error: "Missing required environment variable: OPENAI_API_KEY" };
    }

    const prompt = process.env.AGENT_PROMPT;
    if (!prompt) {
      return { success: false, error: "Missing required environment variable: AGENT_PROMPT" };
    }

    const model = process.env.OPENCODE_MODEL || process.env.AGENT_MODEL || "mimo-v2.5-free";
    const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || "300000", 10);
    const baseUrl = process.env.OPENAI_BASE_URL || "https://opencode.ai/zen/v1";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        return { success: false, error: `API error (status ${response.status}): ${errorText.slice(0, 200)}` };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      return { success: true, output: content };
    } catch (apiError) {
      clearTimeout(timeoutId);
      throw apiError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function run(): Promise<void> {
  const result = await executeAgent();
  process.stdout.write(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// Only auto-execute when this file is the entry point (not when imported by tests)
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  run();
}
