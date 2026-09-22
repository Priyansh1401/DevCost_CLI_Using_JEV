import { describe, expect, it } from "vitest";
import type { JevClient } from "../clients/jev-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import type { CloudStorageDecision } from "../types.js";
import { CloudStorageClassifier } from "./cloud-storage-classifier.js";

class FixedJev implements JevClient {
  constructor(private readonly result: CloudStorageDecision) {}
  async ask<TAnswer>(): Promise<TAnswer> { return this.result as TAnswer; }
}
class FixedLlm implements LlmClient { async summarize(): Promise<string> { return "Old duplicate archive; safe to remove after review."; } }

describe("CloudStorageClassifier", () => {
  it("flags duplicate objects and estimates monthly savings", async () => {
    const classifier = new CloudStorageClassifier(new FixedJev({ classification: "duplicate", confidence: 0.9 }), new FixedLlm(), { storageUsdPerGbMonth: 0.02 });
    const report = await classifier.classifyObjects([{ key: "one.zip", sizeBytes: 500_000_000, contentHash: "same" }, { key: "two.zip", sizeBytes: 500_000_000, contentHash: "same" }]);
    expect(report.flaggedObjects).toHaveLength(2);
    expect(report.estimatedMonthlySavingsUsd).toBeCloseTo(0.02);
  });

  it("escalates decisions in the configured ambiguous range", async () => {
    const result = await new CloudStorageClassifier(new FixedJev({ classification: "stale", confidence: 0.55 }), new FixedLlm()).classifyObject({ key: "old.log", sizeBytes: 1 });
    expect(result).toMatchObject({ escalated: true, llmSummary: "Old duplicate archive; safe to remove after review." });
  });
});
