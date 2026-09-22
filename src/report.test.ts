import { describe, expect, it } from "vitest";
import { DevCostReporter } from "./report.js";
import type { CodeCleanupReport, CloudStorageCleanupReport, LlmCallEvent, TokenWasteReport } from "./types.js";

const event: LlmCallEvent = { id: "call-1", provider: "openai", prompt: "repeat", inputTokens: 10, outputTokens: 20, totalTokens: 30, timestamp: "2026-01-01T00:00:00.000Z", source: "json", rawMetadata: {} };
const tokenWaste: TokenWasteReport = { analyzedEvents: 2, decisions: [{ eventId: "call-1", classification: "duplicate-prompt-pattern", confidence: 0.9 }, { eventId: "call-2", classification: "unclassified", confidence: 0 }], flags: [{ event, classification: "duplicate-prompt-pattern", confidence: 0.9, estimatedCostUsd: 1.25, estimatedSavingsUsd: 1.25, similarEventIds: [] }], estimatedSavingsUsd: 1.25 };
const codeArtifacts: CodeCleanupReport = { scannedAiTouchedFiles: 2, results: [
  { metadata: { path: "src/old.ts", sizeBytes: 10, lastModified: "2026-01-01T00:00:00.000Z", referenceCount: 0, isReferenced: false, aiCommitShas: [], blame: { commitCount: 1 } }, classification: "safe-to-delete", confidence: 0.9, escalated: false },
  { metadata: { path: "src/uncertain.ts", sizeBytes: 10, lastModified: "2026-01-01T00:00:00.000Z", referenceCount: 0, isReferenced: false, aiCommitShas: [], blame: { commitCount: 1 } }, classification: "orphaned", confidence: 0.6, escalated: true, llmSummary: "Review." }
], flaggedFiles: [] };
const storage: CloudStorageCleanupReport = { scannedObjects: 1, results: [{ object: { key: "old.zip", sizeBytes: 1_000_000_000 }, classification: "stale", confidence: 0.9, estimatedMonthlySavingsUsd: 0.23, escalated: false }], flaggedObjects: [{ object: { key: "old.zip", sizeBytes: 1_000_000_000 }, classification: "stale", confidence: 0.9, estimatedMonthlySavingsUsd: 0.23, escalated: false }], estimatedMonthlySavingsUsd: 0.23 };

describe("DevCostReporter", () => {
  it("aggregates mocked module outputs and shows Jev versus Claude resolution", async () => {
    const reporter = new DevCostReporter({
      logScanner: { scanUsageFile: async () => [event] },
      tokenWasteClassifier: { analyze: async () => tokenWaste },
      codeArtifactClassifier: { scan: async () => codeArtifacts },
      cloudStorageClassifier: { scanListingFile: async () => storage }
    });
    const report = await reporter.run({ usageFile: "usage.json", repoPath: "repo", codeArtifactConfig: { aiCommitMarkers: ["Codex"] }, storageListingFile: "objects.json" });
    expect(report.summary).toMatchObject({ totalFlaggedItems: 2, flaggedItems: { tokenWaste: 1, codeArtifacts: 0, storageObjects: 1 }, estimatedSavingsUsd: { total: 1.48 }, decisionBreakdown: { total: 5, jevOnly: 3, escalatedToClaude: 1, unclassified: 1, jevResolutionRate: 0.75 } });
  });
});
