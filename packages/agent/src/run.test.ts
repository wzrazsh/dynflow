import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

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
      text: async () => '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}',
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
