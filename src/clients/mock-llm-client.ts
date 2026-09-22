import type { LlmClient } from "./llm-client.js";

/** Development-only LLM adapter. Never use its output for an actual deletion decision. */
export class MockLlmClient implements LlmClient {
  async summarize(prompt: string): Promise<string> {
    const target = prompt.match(/File or object: ([^\n]+)/)?.[1] ?? "this item";
    return `Mock summary: ${target} requires human review before removal.`;
  }
}
