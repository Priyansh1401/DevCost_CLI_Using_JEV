#!/usr/bin/env node
import { Command } from "commander";
import { JevApiClient } from "./clients/jev-client.js";
import { ClaudeApiClient } from "./clients/llm-client.js";
import { InMemoryDecisionLog } from "./decision-log.js";
import { readAiCommitConfig, CodeArtifactClassifier } from "./modules/code-artifact-classifier.js";
import { CloudStorageClassifier } from "./modules/cloud-storage-classifier.js";
import { LogScanner } from "./modules/log-scanner.js";
import { TokenWasteClassifier } from "./modules/token-waste-classifier.js";
import { DevCostReporter, summaryRows } from "./report.js";

const program = new Command().name("devcost").description("Find avoidable AI API spend.").version("0.1.0");

program.command("scan").requiredOption("-i, --input <file>", "JSON or CSV usage export").option("--git-repo <path>", "repo to enrich events from").option("--git-limit <count>", "commits to inspect", "100").option("--dry-run", "report only; never modify state").action(async (options) => {
  const events = await new LogScanner().scanUsageFile(options.input, { gitRepo: options.gitRepo, gitLimit: Number(options.gitLimit) });
  console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), eventCount: events.length, events }, null, 2));
});

program.command("classify").requiredOption("-i, --input <file>", "JSON or CSV usage export").option("--history-size <count>", "similar prior events supplied to Jev", "5").option("--dry-run", "report only; never modify state").action(async (options) => {
  const events = await new LogScanner().scanUsageFile(options.input);
  const log = new InMemoryDecisionLog();
  const report = await new TokenWasteClassifier(new JevApiClient(), { decisionLog: log }).analyze(events, Number(options.historySize));
  console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), report, decisions: log.list() }, null, 2));
});

program.command("code-artifacts").requiredOption("--repo <path>", "repository to scan").requiredOption("--config <file>", "JSON config with aiCommitMarkers").option("--dry-run", "report only; never modify state").action(async (options) => {
  const log = new InMemoryDecisionLog();
  const report = await new CodeArtifactClassifier(new JevApiClient(), new ClaudeApiClient(), { decisionLog: log }).scan(options.repo, await readAiCommitConfig(options.config));
  printTable("Code artifact cleanup candidates", report.flaggedFiles.map((item) => ({ file: item.metadata.path, classification: item.classification, confidence: item.confidence, references: item.metadata.referenceCount, escalated: item.escalated, summary: item.llmSummary ?? "" })));
  console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), report, decisions: log.list() }, null, 2));
});

program.command("storage").requiredOption("-i, --input <file>", "S3/GCS-style JSON object listing").option("--dry-run", "report only; never modify state").action(async (options) => {
  const log = new InMemoryDecisionLog();
  const report = await new CloudStorageClassifier(new JevApiClient(), new ClaudeApiClient(), { decisionLog: log }).scanListingFile(options.input);
  printTable("Cloud storage cleanup candidates", report.flaggedObjects.map((item) => ({ key: item.object.key, classification: item.classification, confidence: item.confidence, sizeBytes: item.object.sizeBytes, monthlySavingsUsd: item.estimatedMonthlySavingsUsd.toFixed(6), escalated: item.escalated, summary: item.llmSummary ?? "" })));
  console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), report, decisions: log.list() }, null, 2));
});

program.command("report")
  .requiredOption("--usage <file>", "JSON or CSV LLM usage export")
  .requiredOption("--repo <path>", "repository for log and code-artifact scans")
  .requiredOption("--config <file>", "JSON config with aiCommitMarkers")
  .requiredOption("--storage <file>", "S3/GCS-style JSON object listing")
  .option("--history-size <count>", "similar prior events supplied to Jev", "5")
  .option("-o, --output <file>", "JSON report output path", "devcost-report.json")
  .option("--format <format>", "console output: table or json", "table")
  .option("--dry-run", "perform analysis and write only the requested JSON report")
  .action(async (options) => {
    if (options.format !== "table" && options.format !== "json") throw new Error("--format must be table or json.");
    const log = new InMemoryDecisionLog();
    const reporter = new DevCostReporter({
      logScanner: new LogScanner(),
      tokenWasteClassifier: new TokenWasteClassifier(new JevApiClient(), { decisionLog: log }),
      codeArtifactClassifier: new CodeArtifactClassifier(new JevApiClient(), new ClaudeApiClient(), { decisionLog: log }),
      cloudStorageClassifier: new CloudStorageClassifier(new JevApiClient(), new ClaudeApiClient(), { decisionLog: log })
    });
    const report = await reporter.run({ usageFile: options.usage, repoPath: options.repo, codeArtifactConfig: await readAiCommitConfig(options.config), storageListingFile: options.storage, historySize: Number(options.historySize) });
    await reporter.writeJson(report, options.output);
    if (options.format === "table") printTable("DevCost Copilot summary", summaryRows(report.summary));
    else console.log(JSON.stringify(report.summary, null, 2));
    console.log(`JSON report written to ${options.output}${options.dryRun ? " (dry run)" : ""}.`);
  });

function printTable(title: string, rows: Record<string, unknown>[]): void { console.log(`\n${title}`); console.table(rows); }

program.parseAsync();
