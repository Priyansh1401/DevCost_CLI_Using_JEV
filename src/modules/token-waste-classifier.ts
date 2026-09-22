import type { JevClient } from "../clients/jev-client.js";
import type { DecisionLog } from "../decision-log.js";
import type { LlmCallEvent, TokenWasteDecision, TokenWasteFlag, TokenWasteReport, TokenWasteResolution } from "../types.js";

export interface TokenPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface TokenWasteClassifierOptions {
  pricing?: TokenPricing;
  decisionLog?: DecisionLog;
}

const defaultPricing: TokenPricing = { inputPerMillionUsd: 3, outputPerMillionUsd: 15 };

export class TokenWasteClassifier {
  private readonly pricing: TokenPricing;
  constructor(private readonly jevClient: JevClient, private readonly options: TokenWasteClassifierOptions = {}) {
    this.pricing = options.pricing ?? defaultPricing;
  }

  async classifyTokenWaste(event: LlmCallEvent, similarEvents: LlmCallEvent[]): Promise<TokenWasteDecision> {
    return this.jevClient.ask<TokenWasteDecision>(
      "Classify this LLM call as duplicate-prompt-pattern, redundant-regeneration, or novel-request.",
      { event, similarEvents }
    );
  }

  async analyze(events: LlmCallEvent[], historySize = 5): Promise<TokenWasteReport> {
    const flags: TokenWasteFlag[] = [];
    const decisions: TokenWasteResolution[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const similarEvents = findSimilar(event, events.slice(0, index), historySize);
      const decision = await this.classifyTokenWaste(event, similarEvents);
      decisions.push({ eventId: event.id, classification: decision.classification, confidence: decision.confidence });
      if (decision.classification !== "duplicate-prompt-pattern" && decision.classification !== "redundant-regeneration") continue;
      const estimatedCostUsd = this.estimateCost(event);
      const flag: TokenWasteFlag = {
        event,
        classification: decision.classification,
        confidence: decision.confidence,
        estimatedCostUsd,
        estimatedSavingsUsd: estimatedCostUsd,
        similarEventIds: similarEvents.map(({ id }) => id),
        rationale: decision.rationale
      };
      flags.push(flag);
      this.options.decisionLog?.record({ module: "token-waste", subjectId: event.id, classification: flag.classification, estimatedSavingsUsd: flag.estimatedSavingsUsd, metadata: { similarEventIds: flag.similarEventIds } });
    }
    return { analyzedEvents: events.length, decisions, flags, estimatedSavingsUsd: flags.reduce((total, flag) => total + flag.estimatedSavingsUsd, 0) };
  }

  estimateCost(event: LlmCallEvent): number {
    return (event.inputTokens / 1_000_000) * this.pricing.inputPerMillionUsd + (event.outputTokens / 1_000_000) * this.pricing.outputPerMillionUsd;
  }
}

function findSimilar(event: LlmCallEvent, priorEvents: LlmCallEvent[], limit: number): LlmCallEvent[] {
  const fingerprint = normalizePrompt(event.prompt);
  return priorEvents.filter((prior) => normalizePrompt(prior.prompt) === fingerprint || (event.associatedFile && event.associatedFile === prior.associatedFile)).slice(-limit);
}
function normalizePrompt(prompt: string): string { return prompt.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").trim(); }
