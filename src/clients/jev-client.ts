/** Typed decision boundary for Jev. Implement this interface for the real API. */
export interface JevClient {
  ask<TAnswer>(question: string, context: Record<string, unknown>): Promise<TAnswer>;
}

export type RandomNumber = () => number;

export interface JevApiClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

interface JevChoiceAnswer {
  choice?: string;
  confidence?: number;
  probability?: number;
  probabilities?: Record<string, number>;
}
interface JevApiResponse { answers?: Record<string, JevChoiceAnswer>; }

/**
 * Production Jev adapter. `ask` deliberately retains the existing generic signature so
 * all classifiers can keep using the same dependency injection boundary.
 */
export class JevApiClient implements JevClient {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: JevApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.model = options.model ?? process.env.JEV_MODEL ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async ask<TAnswer>(question: string, context: Record<string, unknown>): Promise<TAnswer> {
    const choices = choicesFor(question);
    if (!this.apiKey) return unclassified<TAnswer>("Jev unavailable: TYPESAFE_API_KEY is not set.");
    if (!choices) return unclassified<TAnswer>("Jev unavailable: no typed choices were defined for this question.");
    const body = {
      model: this.model,
      state: context,
      questions: {
        decision: { type: "choice", instructions: question, criteria: choices }
      }
    };
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(this.endpoint, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, this.timeoutMs);
        if (response.ok) {
          const result = await response.json() as JevApiResponse;
          const answer = result.answers?.decision;
          if (answer && typeof answer.choice === "string" && answer.choice in choices) {
            const confidence = answer.confidence ?? answer.probability ?? answer.probabilities?.[answer.choice];
            if (typeof confidence === "number") return { classification: answer.choice, confidence } as TAnswer;
          }
          return unclassified<TAnswer>("Jev returned an invalid typed decision.");
        }
        lastError = `Jev HTTP ${response.status}`;
        if (!isRetryableStatus(response.status) || attempt === this.maxAttempts) break;
        await delay(retryDelay(response, attempt));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === this.maxAttempts) break;
        await delay(backoffMs(attempt));
      }
    }
    return unclassified<TAnswer>(`Jev unavailable after ${this.maxAttempts} attempt(s): ${lastError}`);
  }
}

/** Development-only mock. Kept for deterministic local tests; production uses JevApiClient. */
export class MockJevClient implements JevClient {
  constructor(private readonly random: RandomNumber = Math.random) {}

  async ask<TAnswer>(_question: string, _context: Record<string, unknown>): Promise<TAnswer> {
    const value = this.random();
    const classification = _question.includes("actively-referenced")
      ? (value < 0.25 ? "actively-referenced" : value < 0.5 ? "orphaned" : value < 0.75 ? "duplicate" : "safe-to-delete")
      : _question.includes("stale")
        ? (value < 0.25 ? "active" : value < 0.5 ? "stale" : value < 0.75 ? "duplicate" : "safe-to-delete")
        : value < 0.34 ? "duplicate-prompt-pattern" : value < 0.67 ? "redundant-regeneration" : "novel-request";
    return {
      classification,
      confidence: Number((0.7 + this.random() * 0.29).toFixed(2)),
      rationale: "Mock Jev decision; replace MockJevClient with the production adapter."
    } as TAnswer;
  }
}

function choicesFor(question: string): Record<string, string> | undefined {
  if (question.includes("duplicate-prompt-pattern")) return { "duplicate-prompt-pattern": "Substantially repeats a prior prompt pattern.", "redundant-regeneration": "Repeats a prior request or regeneration without a material new objective.", "novel-request": "Has a materially new objective or context." };
  if (question.includes("actively-referenced")) return { "actively-referenced": "Imported, required, or otherwise used by active repository code.", orphaned: "No active references or clear ownership.", duplicate: "Substantively duplicates another repository artifact.", "safe-to-delete": "Can likely be removed without affecting active behavior." };
  if (question.includes("storage object as active")) return { active: "Linked to an active resource or recently needed.", stale: "Old or unused and a cleanup candidate.", duplicate: "Content duplicates another object.", "safe-to-delete": "Can likely be deleted without affecting active resources." };
  return undefined;
}

function unclassified<TAnswer>(rationale: string): TAnswer { return { classification: "unclassified", confidence: 0, rationale } as TAnswer; }
function isRetryableStatus(status: number): boolean { return status === 429 || status >= 500; }
function backoffMs(attempt: number): number { return Math.min(1_000 * 2 ** (attempt - 1), 8_000); }
function retryDelay(response: Response, attempt: number): number { const seconds = Number(response.headers.get("retry-after")); return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 30_000) : backoffMs(attempt); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs); try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timeout); } }
