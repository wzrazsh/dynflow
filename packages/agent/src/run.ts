import { fileURLToPath } from "node:url";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  files?: string[];
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;
}

interface FileSystemOps {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(file: string, data: string, encoding?: string): Promise<void>;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB per file
const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50 MB total
const OUTPUT_DIR = "/app/output";

const STRUCTURED_OUTPUT_INSTRUCTION = `\n\nIf you need to create files, respond with ONLY a JSON object of this shape:
{
  "files": [
    { "path": "relative/path/file.txt", "content": "file content here" }
  ]
}`;

export function extractFileJson(
  output: string,
): Array<{ path: string; content: string }> {
  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(output);
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files as Array<{ path: string; content: string }>;
    }
  } catch {
    // Not pure JSON — continue to fallback
  }

  // Try 2: Extract from markdown code block.
  // Use first "{" after code block marker and LAST "}" to handle
  // generated file content that itself contains triple backticks.
  if (output.includes('```')) {
    const jsonStart = output.indexOf('{', output.indexOf('```'));
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        const trimmed = output.substring(jsonStart, jsonEnd + 1).trim();
        const parsed = JSON.parse(trimmed);
        if (parsed && Array.isArray(parsed.files)) {
          return parsed.files as Array<{ path: string; content: string }>;
        }
      } catch {
        // Not valid JSON — fall through
      }
    }
  }

  return [];
}

export function isPathSafe(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.startsWith("/")) return false;
  if (filePath.includes("\0")) return false;
  if (filePath.length > 4096) return false;
  const segments = filePath.split(/[/\\]/);
  return !segments.some((s) => s === "..");
}

export async function writeFiles(
  files: Array<{ path: string; content: string }>,
  baseDir: string,
  fsModule?: FileSystemOps,
): Promise<void> {
  const fs = fsModule || { mkdir: fsMkdir, writeFile: fsWriteFile };
  const normalizedBase = path.resolve(baseDir);
  await fs.mkdir(normalizedBase, { recursive: true });
  for (const f of files) {
    const resolved = path.resolve(normalizedBase, f.path);
    if (
      !resolved.startsWith(normalizedBase + path.sep) &&
      resolved !== normalizedBase
    ) {
      throw new Error(`Path traversal detected: ${f.path}`);
    }
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolved, f.content, "utf-8");
  }
}

export function generateSummary(
  files: Array<{ path: string; content: string }>,
): { files: string[]; fileCount: number; totalSize: number } {
  return {
    files: files.map((f) => f.path),
    fileCount: files.length,
    totalSize: files.reduce(
      (sum, f) => sum + Buffer.byteLength(f.content, "utf-8"),
      0,
    ),
  };
}

export async function executeAgent(): Promise<AgentResult> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        error: "Missing required environment variable: OPENAI_API_KEY",
      };
    }

    const prompt = process.env.AGENT_PROMPT;
    if (!prompt) {
      return {
        success: false,
        error: "Missing required environment variable: AGENT_PROMPT",
      };
    }

    const enhancedPrompt = prompt + STRUCTURED_OUTPUT_INSTRUCTION;

    const model =
      process.env.OPENCODE_MODEL ||
      process.env.AGENT_MODEL ||
      "mimo-v2.5-free";
    const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || "300000", 10);
    const baseUrl =
      process.env.OPENAI_BASE_URL || "https://opencode.ai/zen/v1";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: enhancedPrompt }],
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        return {
          success: false,
          error: `API error (status ${response.status}): ${errorText.slice(0, 200)}`,
        };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? "";

      // Try to extract structured file output
      const files = extractFileJson(content);

      if (files.length > 0) {
        // Validate all files
        for (const f of files) {
          if (!isPathSafe(f.path)) {
            return {
              success: false,
              error: `Invalid or unsafe file path: ${f.path}`,
            };
          }
          if (Buffer.byteLength(f.content, "utf-8") > MAX_FILE_SIZE) {
            return {
              success: false,
              error: `File too large: ${f.path} (max 1MB)`,
            };
          }
        }
        if (files.length > MAX_FILE_COUNT) {
          return {
            success: false,
            error: `Too many files: ${files.length} (max ${MAX_FILE_COUNT})`,
          };
        }
        const totalSize = files.reduce(
          (sum, f) => sum + Buffer.byteLength(f.content, "utf-8"),
          0,
        );
        if (totalSize > MAX_TOTAL_SIZE) {
          return {
            success: false,
            error: `Total file size too large: ${totalSize} (max 50MB)`,
          };
        }

        // Write files (failure → don't partially succeed)
        try {
          await writeFiles(files, OUTPUT_DIR);
        } catch (writeError) {
          return {
            success: false,
            error: `Failed to write files: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
          };
        }

        const summary = generateSummary(files);
        return {
          success: true,
          output: `Generated ${files.length} file(s) (${summary.totalSize} bytes)`,
          files: summary.files,
          fileCount: summary.fileCount,
          totalSize: summary.totalSize,
          outputDir: OUTPUT_DIR,
        };
      }

      // Fallback: plain text response (backward compat)
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
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  run();
}
