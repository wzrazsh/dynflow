import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

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
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "42" } }],
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.output).toBe("42");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns success with empty string when no content returned", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });

  it("returns error when OpenAI API call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Insufficient quota"));

    const { executeAgent } = await import("./run.js");
    const result = await executeAgent();

    expect(result.success).toBe(false);
    expect(result.error).toBe("Insufficient quota");
  });

  it("returns error on timeout (AbortController)", { timeout: 15000 }, async () => {
    process.env.AGENT_TIMEOUT_MS = "10";
    // Mock checks signal and rejects when aborted
    mockCreate.mockImplementationOnce(
      async (_body: unknown, options?: { signal?: AbortSignal }) => {
        return new Promise<void>((_resolve, reject) => {
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

  it("uses default model 'gpt-4o' when AGENT_MODEL not set", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    const { executeAgent } = await import("./run.js");
    await executeAgent();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" }),
      expect.any(Object),
    );
  });

  it("uses custom model from AGENT_MODEL env var", async () => {
    process.env.AGENT_MODEL = "gpt-3.5-turbo";
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    const { executeAgent } = await import("./run.js");
    await executeAgent();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-3.5-turbo" }),
      expect.any(Object),
    );
  });
});
