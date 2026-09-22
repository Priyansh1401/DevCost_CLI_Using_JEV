/** Reserved for ambiguous artifact/storage decisions in subsequent modules. */
export interface LlmClient {
  summarize(prompt: string): Promise<string>;
}

export interface ClaudeApiClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

interface ClaudeResponse { content?: Array<{ type?: string; text?: string }>; }

/** Production Claude Messages API adapter for the ambiguity-only escalation path. */
export class ClaudeApiClient implements LlmClient {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: ClaudeApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.model = options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async summarize(prompt: string): Promise<string> {
    if (!this.apiKey) return "Unclassified: Claude escalation unavailable because ANTHROPIC_API_KEY is not set.";
    const body = { model: this.model, max_tokens: 100, system: "Return exactly one concise sentence. Do not claim deletion is safe without qualifying uncertainty.", messages: [{ role: "user", content: prompt }] };
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(this.endpoint, { method: "POST", headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) }, this.timeoutMs);
        if (response.ok) {
          const result = await response.json() as ClaudeResponse;
          const text = result.content?.find((block) => block.type === "text")?.text?.trim();
          return text || "Unclassified: Claude returned no text summary.";
        }
        lastError = `Claude HTTP ${response.status}`;
        if (!isRetryableStatus(response.status) || attempt === this.maxAttempts) break;
        await delay(retryDelay(response, attempt));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === this.maxAttempts) break;
        await delay(backoffMs(attempt));
      }
    }
    return `Unclassified: Claude escalation unavailable after ${this.maxAttempts} attempt(s): ${lastError}`;
  }
}

function isRetryableStatus(status: number): boolean { return status === 429 || status >= 500; }
function backoffMs(attempt: number): number { return Math.min(1_000 * 2 ** (attempt - 1), 8_000); }
function retryDelay(response: Response, attempt: number): number { const seconds = Number(response.headers.get("retry-after")); return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 30_000) : backoffMs(attempt); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs); try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timeout); } }
