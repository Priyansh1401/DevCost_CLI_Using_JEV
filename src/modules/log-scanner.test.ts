import { describe, expect, it } from "vitest";
import { LogScanner } from "./log-scanner.js";

describe("LogScanner", () => {
  it("normalizes common JSON usage fields", () => {
    const events = new LogScanner().parseUsageExport(JSON.stringify({ events: [{ request_id: "r1", provider: "OpenAI", prompt: "hello", prompt_tokens: 12, completion_tokens: 8, created_at: "2026-01-01T00:00:00Z", file_path: "src/a.ts" }] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "r1", provider: "openai", prompt: "hello", inputTokens: 12, outputTokens: 8, totalTokens: 20, associatedFile: "src/a.ts" });
  });

  it("parses quoted CSV prompts", () => {
    const events = new LogScanner().parseUsageExport('id,prompt,input_tokens,output_tokens,timestamp\nr2,"explain, this",10,4,2026-01-01T00:00:00Z', ".csv");
    expect(events[0]).toMatchObject({ id: "r2", prompt: "explain, this", totalTokens: 14, source: "csv" });
  });

  it("enriches an event from matching git history", () => {
    const scanner = new LogScanner();
    const event = scanner.parseUsageExport('[{"id":"r3","prompt":"x","timestamp":"2026-01-01T00:00:00Z"}]');
    const enriched = scanner.enrichWithGitHistory(event, [{ commitSha: "abc999", timestamp: "2026-01-01T00:01:00Z", files: ["src/new.ts"] }]);
    expect(enriched[0]).toMatchObject({ commitSha: "abc999", associatedFile: "src/new.ts" });
  });
});
