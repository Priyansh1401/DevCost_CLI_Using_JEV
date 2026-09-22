import { describe, expect, it } from "vitest";
import type { JevClient } from "../clients/jev-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import type { CodeArtifactDecision, CodeArtifactMetadata } from "../types.js";
import { CodeArtifactClassifier } from "./code-artifact-classifier.js";

class FixedJev implements JevClient {
  constructor(private readonly result: CodeArtifactDecision) {}
  async ask<TAnswer>(): Promise<TAnswer> { return this.result as TAnswer; }
}
class FixedLlm implements LlmClient {
  calls: string[] = [];
  async summarize(prompt: string): Promise<string> { this.calls.push(prompt); return "Unused helper; safe to remove after review."; }
}

const mockFileSystemMetadata: CodeArtifactMetadata = {
  path: "src/generated/old-helper.ts", sizeBytes: 321, lastModified: "2026-01-01T00:00:00.000Z", referenceCount: 0, isReferenced: false, aiCommitShas: ["abc123"], blame: { commitCount: 1, latestCommit: "abc123", latestAuthor: "Dev" }
};

describe("CodeArtifactClassifier", () => {
  it("escalates ambiguous Jev decisions with file metadata", async () => {
    const llm = new FixedLlm();
    const classifier = new CodeArtifactClassifier(new FixedJev({ classification: "safe-to-delete", confidence: 0.6 }), llm);
    const result = await classifier.classifyMetadata(mockFileSystemMetadata);
    expect(result).toMatchObject({ classification: "safe-to-delete", escalated: true, llmSummary: "Unused helper; safe to remove after review." });
    expect(llm.calls[0]).toContain("src/generated/old-helper.ts");
  });

  it("does not call the LLM for confident decisions", async () => {
    const llm = new FixedLlm();
    const result = await new CodeArtifactClassifier(new FixedJev({ classification: "actively-referenced", confidence: 0.9 }), llm).classifyMetadata(mockFileSystemMetadata);
    expect(result.escalated).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });
});
