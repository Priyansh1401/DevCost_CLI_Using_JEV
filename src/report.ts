import { writeFile } from "node:fs/promises";
import type { CodeArtifactClassifier, AiCommitConfig } from "./modules/code-artifact-classifier.js";
import type { CloudStorageClassifier } from "./modules/cloud-storage-classifier.js";
import type { LogScanner } from "./modules/log-scanner.js";
import type { TokenWasteClassifier } from "./modules/token-waste-classifier.js";
import type { DevCostReport, DevCostReportSummary } from "./types.js";

export interface ReportInputs {
  usageFile: string;
  repoPath: string;
  codeArtifactConfig: AiCommitConfig;
  storageListingFile: string;
  historySize?: number;
}

export interface ReportDependencies {
  logScanner: Pick<LogScanner, "scanUsageFile">;
  tokenWasteClassifier: Pick<TokenWasteClassifier, "analyze">;
  codeArtifactClassifier: Pick<CodeArtifactClassifier, "scan">;
  cloudStorageClassifier: Pick<CloudStorageClassifier, "scanListingFile">;
}

export class DevCostReporter {
  constructor(private readonly dependencies: ReportDependencies) {}

  async run(inputs: ReportInputs): Promise<DevCostReport> {
    const logEvents = await this.dependencies.logScanner.scanUsageFile(inputs.usageFile, { gitRepo: inputs.repoPath });
    const [tokenWaste, codeArtifacts, storage] = await Promise.all([
      this.dependencies.tokenWasteClassifier.analyze(logEvents, inputs.historySize),
      this.dependencies.codeArtifactClassifier.scan(inputs.repoPath, inputs.codeArtifactConfig),
      this.dependencies.cloudStorageClassifier.scanListingFile(inputs.storageListingFile)
    ]);
    return { summary: buildSummary(tokenWaste, codeArtifacts, storage), logEvents, tokenWaste, codeArtifacts, storage };
  }

  async writeJson(report: DevCostReport, outputPath: string): Promise<void> {
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

export function buildSummary(report: DevCostReport["tokenWaste"], codeArtifacts: DevCostReport["codeArtifacts"], storage: DevCostReport["storage"]): DevCostReportSummary {
  const tokenUnclassified = report.decisions.filter((decision) => decision.classification === "unclassified").length;
  const codeUnclassified = codeArtifacts.results.filter((result) => result.classification === "unclassified").length;
  const storageUnclassified = storage.results.filter((result) => result.classification === "unclassified").length;
  const escalatedToClaude = codeArtifacts.results.filter((result) => result.escalated).length + storage.results.filter((result) => result.escalated).length;
  const total = report.decisions.length + codeArtifacts.results.length + storage.results.length;
  const unclassified = tokenUnclassified + codeUnclassified + storageUnclassified;
  const jevOnly = total - escalatedToClaude - unclassified;
  const llmWaste = report.estimatedSavingsUsd; const storageSavings = storage.estimatedMonthlySavingsUsd;
  return {
    generatedAt: new Date().toISOString(),
    totalFlaggedItems: report.flags.length + codeArtifacts.flaggedFiles.length + storage.flaggedObjects.length,
    flaggedItems: { tokenWaste: report.flags.length, codeArtifacts: codeArtifacts.flaggedFiles.length, storageObjects: storage.flaggedObjects.length },
    estimatedSavingsUsd: { llmWaste, storage: storageSavings, total: llmWaste + storageSavings },
    decisionBreakdown: { total, jevOnly, escalatedToClaude, unclassified, jevResolutionRate: total - unclassified === 0 ? 0 : jevOnly / (total - unclassified) }
  };
}

export function summaryRows(summary: DevCostReportSummary): Record<string, unknown>[] {
  return [
    { metric: "Flagged token-waste calls", value: summary.flaggedItems.tokenWaste },
    { metric: "Flagged code artifacts", value: summary.flaggedItems.codeArtifacts },
    { metric: "Flagged storage objects", value: summary.flaggedItems.storageObjects },
    { metric: "Estimated LLM waste savings (USD)", value: summary.estimatedSavingsUsd.llmWaste.toFixed(6) },
    { metric: "Estimated storage savings / month (USD)", value: summary.estimatedSavingsUsd.storage.toFixed(6) },
    { metric: "Total estimated savings (USD)", value: summary.estimatedSavingsUsd.total.toFixed(6) },
    { metric: "Jev-only decisions", value: summary.decisionBreakdown.jevOnly },
    { metric: "Escalated to Claude", value: summary.decisionBreakdown.escalatedToClaude },
    { metric: "Unclassified decisions", value: summary.decisionBreakdown.unclassified },
    { metric: "Jev resolution rate", value: `${(summary.decisionBreakdown.jevResolutionRate * 100).toFixed(1)}%` }
  ];
}
