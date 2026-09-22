import type { DecisionLogEntry } from "./types.js";

export interface DecisionLog {
  record(entry: Omit<DecisionLogEntry, "id" | "createdAt">): DecisionLogEntry;
  list(): readonly DecisionLogEntry[];
  totalEstimatedSavingsUsd(): number;
}

export class InMemoryDecisionLog implements DecisionLog {
  private readonly entries: DecisionLogEntry[] = [];

  record(entry: Omit<DecisionLogEntry, "id" | "createdAt">): DecisionLogEntry {
    const stored: DecisionLogEntry = {
      ...entry,
      id: `decision_${this.entries.length + 1}`,
      createdAt: new Date().toISOString()
    };
    this.entries.push(stored);
    return stored;
  }

  list(): readonly DecisionLogEntry[] { return this.entries; }

  totalEstimatedSavingsUsd(): number {
    return this.entries.reduce((total, entry) => total + entry.estimatedSavingsUsd, 0);
  }
}
