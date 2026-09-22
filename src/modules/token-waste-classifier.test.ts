import { describe, expect, it } from "vitest";
import type { JevClient } from "../clients/jev-client.js";
import { InMemoryDecisionLog } from "../decision-log.js";
import type { LlmCallEvent, TokenWasteDecision } from "../types.js";
import { TokenWasteClassifier } from "./token-waste-classifier.js";

const event = (id: string, prompt = "Write tests"): LlmCallEvent => ({ id, provider: "openai", prompt, inputTokens: 1_000, outputTokens: 2_000, totalTokens: 3_000, timestamp: "2026-01-01T00:00:00Z", source: "json", rawMetadata: {} });

class FixedJevClient implements JevClient {
  constructor(private readonly decision: TokenWasteDecision) {}
  async ask<TAnswer>(): Promise<TAnswer> { return this.decision as TAnswer; }
}

describe("TokenWasteClassifier", () => {
  it("flags non-novel decisions, estimates their cost, and records them", async () => {
    const log = new InMemoryDecisionLog();
    const classifier = new TokenWasteClassifier(new FixedJevClient({ classification: "duplicate-prompt-pattern", confidence: 0.95 }), { decisionLog: log, pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 10 } });
    const report = await classifier.analyze([event("one"), event("two")]);
    expect(report.flags).toHaveLength(2);
    expect(report.flags[1].similarEventIds).toEqual(["one"]);
    expect(report.estimatedSavingsUsd).toBeCloseTo(0.044);
    expect(log.list()).toHaveLength(2);
  });

  it("does not flag novel requests", async () => {
    const classifier = new TokenWasteClassifier(new FixedJevClient({ classification: "novel-request", confidence: 0.8 }));
    await expect(classifier.analyze([event("one")])).resolves.toMatchObject({ flags: [], estimatedSavingsUsd: 0 });
  });
});
