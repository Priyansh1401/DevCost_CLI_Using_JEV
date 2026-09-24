import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevClient } from "../clients/jev-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import type { CodeArtifactDecision, CodeArtifactMetadata } from "../types.js";
import { CodeArtifactClassifier, countReferences } from "./code-artifact-classifier.js";

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
  it("skips default-excluded project files before they can enter the flagged report", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "devcost-exclusion-test-"));
    try {
      await mkdir(join(repoPath, "src"));
      await writeFile(join(repoPath, "package.json"), "{}", "utf8");
      await writeFile(join(repoPath, "README.md"), "# Documentation", "utf8");
      await writeFile(join(repoPath, "tsconfig.json"), "{}", "utf8");
      await writeFile(join(repoPath, ".gitignore"), "node_modules/", "utf8");
      await writeFile(join(repoPath, "src", "candidate.ts"), "export const candidate = true;", "utf8");
      for (const arguments_ of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test User"], ["add", "."], ["commit", "-m", "Codex generated candidate"]]) execFileSync("git", ["-C", repoPath, ...arguments_], { encoding: "utf8" });
      const report = await new CodeArtifactClassifier(new FixedJev({ classification: "orphaned", confidence: 0.9 }), new FixedLlm()).scan(repoPath, { aiCommitMarkers: ["Codex"] });
      expect(report.flaggedFiles.map((result) => result.metadata.path)).toEqual(["src/candidate.ts"]);
      expect(report.results.map((result) => result.metadata.path)).not.toContain("package.json");
      expect(report.results.map((result) => result.metadata.path)).not.toContain("README.md");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("counts static imports and require calls without matching unrelated files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "devcost-reference-test-"));
    try {
      await mkdir(join(repoPath, "src"));
      await writeFile(join(repoPath, "src", "target.ts"), "export const target = true;", "utf8");
      await writeFile(join(repoPath, "src", "esm.ts"), 'import { target } from "./target";\nvoid target;', "utf8");
      await writeFile(join(repoPath, "src", "commonjs.ts"), 'const { target } = require("./target");\nvoid target;', "utf8");
      await writeFile(join(repoPath, "src", "unrelated.ts"), 'import { something } from "./something-else";', "utf8");
      const files = ["src/target.ts", "src/esm.ts", "src/commonjs.ts", "src/unrelated.ts"];
      await expect(countReferences(repoPath, "src/target.ts", ["src/target.ts", "src/esm.ts"])).resolves.toBe(1);
      await expect(countReferences(repoPath, "src/target.ts", ["src/target.ts", "src/commonjs.ts"])).resolves.toBe(1);
      await expect(countReferences(repoPath, "src/target.ts", ["src/target.ts", "src/unrelated.ts"])).resolves.toBe(0);
      await expect(countReferences(repoPath, "src/target.ts", files)).resolves.toBe(2);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

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
