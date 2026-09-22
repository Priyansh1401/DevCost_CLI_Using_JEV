import { afterEach, describe, expect, it, vi } from "vitest";
import { JevApiClient } from "./jev-client.js";
import { ClaudeApiClient } from "./llm-client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("production API clients", () => {
  it("sends typed Jev choices and returns its calibrated decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { decision: { choice: "orphaned", confidence: 0.88 } } }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const answer = await new JevApiClient({ apiKey: "jev-test", endpoint: "https://jev.test", maxAttempts: 1 }).ask<{ classification: string; confidence: number }>("Classify this code artifact as actively-referenced, orphaned, duplicate, or safe-to-delete.", { path: "src/x.ts" });
    expect(answer).toEqual({ classification: "orphaned", confidence: 0.88 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://jev.test");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).questions.decision.type).toBe("choice");
  });

  it("returns an unclassified fallback when the Jev key is absent", async () => {
    const answer = await new JevApiClient({ apiKey: "", maxAttempts: 1 }).ask<{ classification: string; confidence: number; rationale: string }>("Classify this storage object as active, stale, duplicate, or safe-to-delete.", {});
    expect(answer.classification).toBe("unclassified");
    expect(answer.rationale).toContain("JEV_API_KEY");
  });

  it("sends an Anthropic Messages API request and extracts text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "Unused helper; review before removal." }] }), { status: 200 }));
    globalThis.fetch = fetchMock;
    await expect(new ClaudeApiClient({ apiKey: "anthropic-test", endpoint: "https://claude.test", maxAttempts: 1 }).summarize("Summarize this file")).resolves.toBe("Unused helper; review before removal.");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("anthropic-test");
  });
});
