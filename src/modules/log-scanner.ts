import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { assertLocalGitRepository, runGitCommand } from "../git-utils.js";
import type { LlmCallEvent, LlmProvider } from "../types.js";

export interface GitChange {
  commitSha: string;
  timestamp: string;
  files: string[];
}

export interface LogScanOptions {
  gitRepo?: string;
  gitLimit?: number;
}

const fieldAliases = {
  prompt: ["prompt", "input", "input_text", "request", "message"],
  inputTokens: ["input_tokens", "prompt_tokens", "tokens_in"],
  outputTokens: ["output_tokens", "completion_tokens", "tokens_out"],
  totalTokens: ["total_tokens", "token_count", "tokens"],
  timestamp: ["timestamp", "created_at", "created", "time"],
  commitSha: ["commit", "commit_sha", "git_commit"],
  associatedFile: ["file", "file_path", "associated_file", "path"],
  provider: ["provider", "vendor"],
  model: ["model", "model_name"]
} as const;

type RawRecord = Record<string, unknown>;

export class LogScanner {
  async scanUsageFile(filePath: string, options: LogScanOptions = {}): Promise<LlmCallEvent[]> {
    const content = await readFile(filePath, "utf8");
    const events = this.parseUsageExport(content, extname(filePath));
    return options.gitRepo ? this.enrichWithGitHistory(events, this.scanGitHistory(options.gitRepo, options.gitLimit)) : events;
  }

  parseUsageExport(content: string, extension = ".json"): LlmCallEvent[] {
    const records = extension.toLowerCase() === ".csv" ? parseCsv(content) : parseJson(content);
    return records.map((record, index) => normalizeRecord(record, index, extension.toLowerCase() === ".csv" ? "csv" : "json"));
  }

  scanGitHistory(repoPath: string, limit = 100): GitChange[] {
    assertLocalGitRepository(repoPath);
    const output = runGitCommand(repoPath, ["log", `--max-count=${limit}`, "--name-only", "--format=%H%x1f%cI"], "reading commit history");
    const changes: GitChange[] = [];
    let current: GitChange | undefined;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [sha, timestamp] = line.split("\u001f");
      if (timestamp) {
        current = { commitSha: sha, timestamp, files: [] };
        changes.push(current);
      } else if (current) current.files.push(line);
    }
    return changes;
  }

  enrichWithGitHistory(events: LlmCallEvent[], changes: GitChange[]): LlmCallEvent[] {
    return events.map((event) => {
      const byCommit = event.commitSha ? changes.find((change) => change.commitSha.startsWith(event.commitSha!)) : undefined;
      const nearest = byCommit ?? nearestChange(event.timestamp, changes);
      if (!nearest) return event;
      return {
        ...event,
        commitSha: event.commitSha ?? nearest.commitSha,
        associatedFile: event.associatedFile ?? nearest.files[0],
        rawMetadata: { ...event.rawMetadata, gitFiles: nearest.files }
      };
    });
  }
}

function normalizeRecord(record: RawRecord, index: number, source: "json" | "csv"): LlmCallEvent {
  const value = (aliases: readonly string[]): unknown => {
    const key = Object.keys(record).find((candidate) => aliases.includes(candidate.toLowerCase() as never));
    return key ? record[key] : undefined;
  };
  const inputTokens = asNumber(value(fieldAliases.inputTokens));
  const outputTokens = asNumber(value(fieldAliases.outputTokens));
  const declaredTotal = asNumber(value(fieldAliases.totalTokens));
  const providerValue = String(value(fieldAliases.provider) ?? "unknown").toLowerCase();
  const provider: LlmProvider = providerValue.includes("openai") ? "openai" : providerValue.includes("anthropic") || providerValue.includes("claude") ? "anthropic" : "unknown";
  const timestamp = value(fieldAliases.timestamp);
  return {
    id: String(record.id ?? record.request_id ?? `usage_${index + 1}`),
    provider,
    model: stringOrUndefined(value(fieldAliases.model)),
    prompt: String(value(fieldAliases.prompt) ?? ""),
    inputTokens,
    outputTokens,
    totalTokens: declaredTotal || inputTokens + outputTokens,
    timestamp: timestamp ? new Date(String(timestamp)).toISOString() : new Date(0).toISOString(),
    associatedFile: stringOrUndefined(value(fieldAliases.associatedFile)),
    commitSha: stringOrUndefined(value(fieldAliases.commitSha)),
    source,
    rawMetadata: record
  };
}

function parseJson(content: string): RawRecord[] {
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed as RawRecord[];
  if (parsed && typeof parsed === "object") {
    const container = parsed as Record<string, unknown>;
    for (const key of ["events", "data", "usage", "records"]) if (Array.isArray(container[key])) return container[key] as RawRecord[];
  }
  throw new Error("Expected a JSON array or an object containing events, data, usage, or records.");
}

function parseCsv(content: string): RawRecord[] {
  const rows = content.split(/\r?\n/).filter(Boolean).map(parseCsvRow);
  const [headers, ...data] = rows;
  if (!headers?.length) return [];
  return data.map((values) => Object.fromEntries(headers.map((header, i) => [header.trim(), values[i] ?? ""])));
}

function parseCsvRow(row: string): string[] {
  const cells: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '"' && row[i + 1] === '"' && quoted) { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell); return cells;
}

function asNumber(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function stringOrUndefined(value: unknown): string | undefined { return value === undefined || value === null || value === "" ? undefined : String(value); }
function nearestChange(timestamp: string, changes: GitChange[]): GitChange | undefined {
  const eventTime = new Date(timestamp).getTime();
  return changes.reduce<GitChange | undefined>((closest, candidate) => !closest || Math.abs(new Date(candidate.timestamp).getTime() - eventTime) < Math.abs(new Date(closest.timestamp).getTime() - eventTime) ? candidate : closest, undefined);
}
