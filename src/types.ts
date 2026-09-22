export type LlmProvider = "openai" | "anthropic" | "unknown";

export interface LlmCallEvent {
  id: string;
  provider: LlmProvider;
  model?: string;
  prompt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: string;
  associatedFile?: string;
  commitSha?: string;
  source: "json" | "csv" | "git";
  rawMetadata: Record<string, unknown>;
}

export type TokenWasteLabel =
  | "duplicate-prompt-pattern"
  | "redundant-regeneration"
  | "novel-request"
  | "unclassified";

export interface TokenWasteDecision {
  classification: TokenWasteLabel;
  confidence: number;
  rationale?: string;
}

export interface TokenWasteFlag {
  event: LlmCallEvent;
  classification: "duplicate-prompt-pattern" | "redundant-regeneration";
  confidence: number;
  estimatedCostUsd: number;
  estimatedSavingsUsd: number;
  similarEventIds: string[];
  rationale?: string;
}

export interface TokenWasteReport {
  analyzedEvents: number;
  decisions: TokenWasteResolution[];
  flags: TokenWasteFlag[];
  estimatedSavingsUsd: number;
}

export interface TokenWasteResolution {
  eventId: string;
  classification: TokenWasteLabel;
  confidence: number;
}

export interface DecisionLogEntry {
  id: string;
  createdAt: string;
  module: "token-waste" | "code-artifact" | "cloud-storage";
  subjectId: string;
  classification: string;
  estimatedSavingsUsd: number;
  metadata?: Record<string, unknown>;
}

export type CodeArtifactLabel = "actively-referenced" | "orphaned" | "duplicate" | "safe-to-delete" | "unclassified";

export interface GitBlameInfo {
  commitCount: number;
  latestCommit?: string;
  latestAuthor?: string;
}

export interface CodeArtifactMetadata {
  path: string;
  sizeBytes: number;
  lastModified: string;
  referenceCount: number;
  isReferenced: boolean;
  aiCommitShas: string[];
  blame: GitBlameInfo;
}

export interface CodeArtifactDecision {
  classification: CodeArtifactLabel;
  confidence: number;
  rationale?: string;
}

export interface CodeArtifactResult {
  metadata: CodeArtifactMetadata;
  classification: CodeArtifactLabel;
  confidence: number;
  rationale?: string;
  escalated: boolean;
  llmSummary?: string;
}

export interface CodeCleanupReport {
  scannedAiTouchedFiles: number;
  results: CodeArtifactResult[];
  flaggedFiles: CodeArtifactResult[];
}

export type CloudStorageLabel = "active" | "stale" | "duplicate" | "safe-to-delete" | "unclassified";

export interface CloudObjectMetadata {
  key: string;
  sizeBytes: number;
  lastAccessed?: string;
  contentHash?: string;
  linkedResourceId?: string;
}

export interface CloudStorageDecision {
  classification: CloudStorageLabel;
  confidence: number;
  rationale?: string;
}

export interface CloudStorageResult {
  object: CloudObjectMetadata;
  classification: CloudStorageLabel;
  confidence: number;
  estimatedMonthlySavingsUsd: number;
  rationale?: string;
  escalated: boolean;
  llmSummary?: string;
}

export interface CloudStorageCleanupReport {
  scannedObjects: number;
  results: CloudStorageResult[];
  flaggedObjects: CloudStorageResult[];
  estimatedMonthlySavingsUsd: number;
}

export interface DevCostReportSummary {
  generatedAt: string;
  totalFlaggedItems: number;
  flaggedItems: { tokenWaste: number; codeArtifacts: number; storageObjects: number };
  estimatedSavingsUsd: { llmWaste: number; storage: number; total: number };
  decisionBreakdown: { total: number; jevOnly: number; escalatedToClaude: number; unclassified: number; jevResolutionRate: number };
}

export interface DevCostReport {
  summary: DevCostReportSummary;
  logEvents: LlmCallEvent[];
  tokenWaste: TokenWasteReport;
  codeArtifacts: CodeCleanupReport;
  storage: CloudStorageCleanupReport;
}
