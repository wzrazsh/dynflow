import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

// Mock filesystem for executeAgent integration tests that write files
const { mockFsMkdir, mockFsWriteFile } = vi.hoisted(() => ({
  mockFsMkdir: vi.fn().mockResolvedValue(undefined),
  mockFsWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockFsMkdir,
  writeFile: mockFsWriteFile,
}));

import {
  extractFileJson,
  isPathSafe,
  generateSummary,
} from "./run.js";

describe("agent executeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key-123";
    process.env.AGENT_PROMPT = "What is the meaning of life?";
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AGENT_PROMPT;
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_TIMEOUT_MS;
  });

  it("returns success with output on successful API call", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "42" } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.output).toBe("42");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns success with empty string when no content returned", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });

  it("returns error when OpenAI API call fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () =>
        '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}',
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error (status 401)");
  });

  it("returns error on timeout (AbortController)", { timeout: 15000 }, async () => {
    process.env.AGENT_TIMEOUT_MS = "10";
    // Mock fetch to hang until signal abort
    mockFetch.mockImplementationOnce(
      (_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            if (options.signal.aborted) {
              reject(new Error("The operation was aborted"));
              return;
            }
            options.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }
        });
      },
    );

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns error when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(false);
    expect(result.error).toContain("OPENAI_API_KEY");
  });

  it("returns error when AGENT_PROMPT is missing", async () => {
    delete process.env.AGENT_PROMPT;

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(false);
    expect(result.error).toContain("AGENT_PROMPT");
  });

  it("uses default model 'mimo-v2.5-free' when AGENT_MODEL not set", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    await executeAgent();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.model).toBe("mimo-v2.5-free");
  });

  it("uses custom model from AGENT_MODEL env var", async () => {
    process.env.AGENT_MODEL = "gpt-3.5-turbo";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    await executeAgent();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.model).toBe("gpt-3.5-turbo");
  });
});

describe("file output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key-123";
    process.env.AGENT_PROMPT = "Create files";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AGENT_PROMPT;
  });

  // -----------------------------------------------------------------------
  // executeAgent integration tests — structured file output
  // -----------------------------------------------------------------------

  it("parses file JSON from LLM response and writes files", async () => {
    const fileJson = JSON.stringify({
      files: [{ path: "index.html", content: "<html></html>" }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: fileJson } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.files).toEqual(["index.html"]);
    expect(result.fileCount).toBe(1);
    expect(result.totalSize).toBe(13);
    expect(result.outputDir).toBe("/app/output");
    expect(result.output).toContain("Generated 1 file(s)");

    // Verify filesystem was called
    expect(mockFsMkdir).toHaveBeenCalled();
    expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
  });

  it("handles multiple files from LLM response", async () => {
    const fileJson = JSON.stringify({
      files: [
        { path: "index.html", content: "<html></html>" },
        { path: "style.css", content: "body { margin: 0; }" },
      ],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: fileJson } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files![0]).toBe("index.html");
    expect(result.files![1]).toBe("style.css");
    expect(result.fileCount).toBe(2);
    // <html></html> = 13 bytes, "body { margin: 0; }" = 19 bytes
    expect(result.totalSize).toBe(32);
    expect(result.output).toContain("Generated 2 file(s)");
    expect(result.outputDir).toBe("/app/output");
    expect(mockFsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("returns plain text output when LLM responds with non-JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Here is your HTML file." } }],
      }),
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.output).toBe("Here is your HTML file.");
    // No file-related fields when no JSON files detected
    expect(result.files).toBeUndefined();
    expect(result.fileCount).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // extractFileJson unit tests
  // -----------------------------------------------------------------------

  it("extractFileJson parses valid JSON with files array", () => {
    const json = JSON.stringify({
      files: [{ path: "test.txt", content: "hello" }],
    });
    const files = extractFileJson(json);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("test.txt");
    expect(files[0].content).toBe("hello");
  });

  it("extractFileJson returns empty array for plain text", () => {
    expect(extractFileJson("Hello world")).toEqual([]);
  });

  it("extractFileJson returns empty array when files key is missing", () => {
    expect(extractFileJson(JSON.stringify({ foo: "bar" }))).toEqual([]);
  });

  it("extractFileJson returns empty array when files is not an array", () => {
    expect(extractFileJson(JSON.stringify({ files: "not-an-array" }))).toEqual([]);
  });

  it("extractFileJson returns empty array for malformed JSON", () => {
    expect(extractFileJson("{broken json")).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // isPathSafe unit tests
  // -----------------------------------------------------------------------

  it("isPathSafe allows normal relative paths", () => {
    expect(isPathSafe("index.html")).toBe(true);
    expect(isPathSafe("subdir/file.js")).toBe(true);
    expect(isPathSafe("a/b/c/d.txt")).toBe(true);
    expect(isPathSafe("./relative.txt")).toBe(true);
  });

  it("isPathSafe rejects path traversal with ../", () => {
    expect(isPathSafe("../evil.txt")).toBe(false);
    expect(isPathSafe("foo/../../bar.txt")).toBe(false);
    expect(isPathSafe("a/b/../c")).toBe(false);
    expect(isPathSafe("..")).toBe(false);
  });

  it("isPathSafe rejects absolute paths", () => {
    expect(isPathSafe("/etc/passwd")).toBe(false);
    expect(isPathSafe("/app/secret.key")).toBe(false);
  });

  it("isPathSafe rejects empty path", () => {
    expect(isPathSafe("")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // File writing test (dependency injection pattern)
  // -----------------------------------------------------------------------

  it("writes extracted files to output directory", async () => {
    const { writeFiles } = await import("./run.js");
    const mockMkdir = vi.fn().mockResolvedValue(undefined);
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    const mockFs = { mkdir: mockMkdir, writeFile: mockWriteFile };

    const files = [
      { path: "hello.txt", content: "world" },
      { path: "subdir/foo.js", content: "console.log('hi')" },
    ];

    await writeFiles(files, "/app/output", mockFs);

    // mkdir should have been called for baseDir (cross-platform path)
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]output/),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/hello\.txt$/),
      "world",
      "utf-8",
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/subdir[/\\]foo\.js$/),
      "console.log('hi')",
      "utf-8",
    );
  });

  // -----------------------------------------------------------------------
  // File summary test
  // -----------------------------------------------------------------------

  it("generates file summary with files, count, and total size", () => {
    const result = generateSummary([
      { path: "a.txt", content: "hello" },
      { path: "b.txt", content: "world!" },
    ]);

    expect(result.files).toEqual(["a.txt", "b.txt"]);
    expect(result.fileCount).toBe(2);
    expect(result.totalSize).toBe(11); // 5 + 6
  });

  it("generateSummary returns zeros for empty file list", () => {
    expect(generateSummary([])).toEqual({
      files: [],
      fileCount: 0,
      totalSize: 0,
    });
  });
});
