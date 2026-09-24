import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { assertLocalGitRepository, runGitCommand } from "../git-utils.js";
import type { JevClient } from "../clients/jev-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import type { DecisionLog } from "../decision-log.js";
import type { CodeArtifactDecision, CodeArtifactMetadata, CodeArtifactResult, CodeCleanupReport, GitBlameInfo } from "../types.js";

export interface AiCommitConfig {
  aiCommitMarkers: string[];
  /** Glob patterns matched against file names before any metadata or Jev work is performed. */
  artifactExclusions?: string[];
}
export interface CodeArtifactClassifierOptions { ambiguityMin?: number; ambiguityMax?: number; decisionLog?: DecisionLog; }

export const DEFAULT_ARTIFACT_EXCLUSIONS = ["package.json", "package-lock.json", "tsconfig.json", "README*", ".gitignore", "*.config.js"];

export class CodeArtifactClassifier {
  private readonly ambiguityMin: number;
  private readonly ambiguityMax: number;
  constructor(private readonly jevClient: JevClient, private readonly llmClient: LlmClient, private readonly options: CodeArtifactClassifierOptions = {}) {
    this.ambiguityMin = options.ambiguityMin ?? 0.5;
    this.ambiguityMax = options.ambiguityMax ?? 0.7;
  }

  async scan(repoPath: string, config: AiCommitConfig): Promise<CodeCleanupReport> {
    validateConfig(config);
    assertLocalGitRepository(repoPath);
    const exclusions = config.artifactExclusions ?? DEFAULT_ARTIFACT_EXCLUSIONS;
    const candidates = getAiTouchedFiles(repoPath, config.aiCommitMarkers).filter((candidate) => !isExcludedArtifact(candidate.path, exclusions));
    const results: CodeArtifactResult[] = [];
    for (const candidate of candidates) {
      try { results.push(await this.classifyMetadata(await collectMetadata(repoPath, candidate.path, candidate.commitShas))); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error; }
    }
    return { scannedAiTouchedFiles: results.length, results, flaggedFiles: results.filter((result) => result.classification !== "actively-referenced") };
  }

  async classifyMetadata(metadata: CodeArtifactMetadata): Promise<CodeArtifactResult> {
    const decision = await this.jevClient.ask<CodeArtifactDecision>("Classify this code artifact as actively-referenced, orphaned, duplicate, or safe-to-delete.", { metadata });
    const escalated = decision.confidence >= this.ambiguityMin && decision.confidence < this.ambiguityMax;
    const llmSummary = escalated ? await this.llmClient.summarize(`File or object: ${metadata.path}\nProvide one line: what does it do and is it safe to remove?\nMetadata: ${JSON.stringify(metadata)}`) : undefined;
    const result = { metadata, ...decision, escalated, llmSummary };
    this.options.decisionLog?.record({ module: "code-artifact", subjectId: metadata.path, classification: decision.classification, estimatedSavingsUsd: 0, metadata: { confidence: decision.confidence, escalated } });
    return result;
  }
}

export async function readAiCommitConfig(configPath: string): Promise<AiCommitConfig> { return JSON.parse(await readFile(configPath, "utf8")) as AiCommitConfig; }

function validateConfig(config: AiCommitConfig): void {
  if (!Array.isArray(config.aiCommitMarkers) || config.aiCommitMarkers.length === 0 || !config.aiCommitMarkers.every((marker) => typeof marker === "string" && marker.trim())) throw new Error("Config must contain a non-empty aiCommitMarkers string array.");
  if (config.artifactExclusions !== undefined && (!Array.isArray(config.artifactExclusions) || !config.artifactExclusions.every((pattern) => typeof pattern === "string" && pattern.trim()))) throw new Error("artifactExclusions must be a string array when provided.");
}

function getAiTouchedFiles(repoPath: string, markers: string[]): Array<{ path: string; commitShas: string[] }> {
  const output = runGitCommand(repoPath, ["log", "--name-only", "--format=%H%x1f%s"], "reading AI-marked commits");
  const matching = markers.map((marker) => marker.toLowerCase());
  const byPath = new Map<string, string[]>(); let currentSha: string | undefined; let relevant = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, subject] = line.split("\u001f");
    if (subject !== undefined) { currentSha = sha; relevant = matching.some((marker) => subject.toLowerCase().includes(marker)); }
    else if (relevant && currentSha && !line.endsWith("/")) byPath.set(line, [...(byPath.get(line) ?? []), currentSha]);
  }
  return [...byPath].map(([path, commitShas]) => ({ path, commitShas }));
}

async function collectMetadata(repoPath: string, repoRelativePath: string, aiCommitShas: string[]): Promise<CodeArtifactMetadata> {
  const absolutePath = resolve(repoPath, repoRelativePath); const fileStat = await stat(absolutePath);
  const allFiles = await walkFiles(repoPath); const referenceCount = await countReferences(repoPath, repoRelativePath, allFiles);
  return { path: repoRelativePath.replace(/\\/g, "/"), sizeBytes: fileStat.size, lastModified: fileStat.mtime.toISOString(), referenceCount, isReferenced: referenceCount > 0, aiCommitShas, blame: getBlame(repoPath, repoRelativePath) };
}

async function walkFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }); const found: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, fullPath));
    else if (entry.isFile()) found.push(relative(root, fullPath));
  }
  return found;
}

/** Counts ESM `from`, CommonJS `require`, and dynamic `import` references to a target file. */
export async function countReferences(repoPath: string, targetPath: string, files: string[]): Promise<number> {
  const targetName = basename(targetPath).replace(/\.[^.]+$/, ""); const targetNormalized = targetPath.replace(/\\/g, "/").replace(/\.[^.]+$/, "");
  const targetSpecifier = `(?:${escapeRegex(targetNormalized)}|${escapeRegex(targetName)})`;
  const pattern = new RegExp(
    `(?:from\\s+["'][^"']*${targetSpecifier}[^"']*["']|require\\(\\s*["'][^"']*${targetSpecifier}[^"']*["']\\s*\\)|import\\(\\s*["'][^"']*${targetSpecifier}[^"']*["']\\s*\\))`,
    "g"
  );
  let count = 0;
  for (const file of files) { if (file.replace(/\\/g, "/") === targetPath.replace(/\\/g, "/")) continue; try { count += (await readFile(resolve(repoPath, file), "utf8")).match(pattern)?.length ?? 0; } catch { /* ignore binary/unreadable files */ } }
  return count;
}

function getBlame(repoPath: string, path: string): GitBlameInfo {
  const output = runGitCommand(repoPath, ["blame", "--line-porcelain", "--", path], `reading blame for '${path}'`);
  const commits = [...output.matchAll(/^([0-9a-f]{40}) /gm)].map((match) => match[1]); const author = output.match(/^author (.+)$/m)?.[1];
  return { commitCount: new Set(commits).size, latestCommit: commits[0], latestAuthor: author };
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isExcludedArtifact(path: string, patterns: string[]): boolean {
  const fileName = basename(path);
  return patterns.some((pattern) => new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i").test(fileName));
}
