import { readFile } from "node:fs/promises";
import type { JevClient } from "../clients/jev-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import type { DecisionLog } from "../decision-log.js";
import type { CloudObjectMetadata, CloudStorageCleanupReport, CloudStorageDecision, CloudStorageResult } from "../types.js";

export interface CloudStorageClassifierOptions {
  ambiguityMin?: number;
  ambiguityMax?: number;
  storageUsdPerGbMonth?: number;
  decisionLog?: DecisionLog;
}

export class CloudStorageClassifier {
  private readonly ambiguityMin: number;
  private readonly ambiguityMax: number;
  private readonly storageUsdPerGbMonth: number;
  constructor(private readonly jevClient: JevClient, private readonly llmClient: LlmClient, private readonly options: CloudStorageClassifierOptions = {}) {
    this.ambiguityMin = options.ambiguityMin ?? 0.5;
    this.ambiguityMax = options.ambiguityMax ?? 0.7;
    this.storageUsdPerGbMonth = options.storageUsdPerGbMonth ?? 0.023;
  }

  async scanListingFile(filePath: string): Promise<CloudStorageCleanupReport> { return this.classifyObjects(parseListing(await readFile(filePath, "utf8"))); }

  async classifyObjects(objects: CloudObjectMetadata[]): Promise<CloudStorageCleanupReport> {
    const byHash = new Map<string, CloudObjectMetadata[]>();
    for (const object of objects) if (object.contentHash) byHash.set(object.contentHash, [...(byHash.get(object.contentHash) ?? []), object]);
    const results = await Promise.all(objects.map((object) => this.classifyObject(object, (object.contentHash ? byHash.get(object.contentHash) : [])?.filter(({ key }) => key !== object.key) ?? [])));
    const flaggedObjects = results.filter((result) => result.classification !== "active");
    return { scannedObjects: objects.length, results, flaggedObjects, estimatedMonthlySavingsUsd: flaggedObjects.reduce((total, item) => total + item.estimatedMonthlySavingsUsd, 0) };
  }

  async classifyObject(object: CloudObjectMetadata, hashMatches: CloudObjectMetadata[] = []): Promise<CloudStorageResult> {
    const decision = await this.jevClient.ask<CloudStorageDecision>("Classify this storage object as active, stale, duplicate, or safe-to-delete.", { object, linkedToActiveResource: Boolean(object.linkedResourceId), duplicateKeys: hashMatches.map(({ key }) => key) });
    const escalated = decision.confidence >= this.ambiguityMin && decision.confidence < this.ambiguityMax;
    const llmSummary = escalated ? await this.llmClient.summarize(`File or object: ${object.key}\nProvide one line: what is it and is it safe to remove?\nMetadata: ${JSON.stringify({ object, hashMatches })}`) : undefined;
    const estimatedMonthlySavingsUsd = decision.classification === "stale" || decision.classification === "duplicate" || decision.classification === "safe-to-delete" ? (object.sizeBytes / 1_000_000_000) * this.storageUsdPerGbMonth : 0;
    const result = { object, ...decision, estimatedMonthlySavingsUsd, escalated, llmSummary };
    this.options.decisionLog?.record({ module: "cloud-storage", subjectId: object.key, classification: decision.classification, estimatedSavingsUsd: estimatedMonthlySavingsUsd, metadata: { confidence: decision.confidence, duplicateCount: hashMatches.length, escalated } });
    return result;
  }
}

function parseListing(content: string): CloudObjectMetadata[] {
  const parsed: unknown = JSON.parse(content);
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).objects ?? (parsed as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) throw new Error("Expected a JSON array or an object with objects/items array.");
  return items.map((item, index) => normalizeObject(item as Record<string, unknown>, index));
}

function normalizeObject(raw: Record<string, unknown>, index: number): CloudObjectMetadata {
  const key = raw.key ?? raw.name ?? raw.path;
  if (typeof key !== "string" || !key) throw new Error(`Object ${index} is missing a key.`);
  const sizeBytes = Number(raw.sizeBytes ?? raw.size_bytes ?? raw.size ?? 0);
  return { key, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0, lastAccessed: stringValue(raw.lastAccessed ?? raw.last_accessed), contentHash: stringValue(raw.contentHash ?? raw.content_hash ?? raw.etag), linkedResourceId: stringValue(raw.linkedResourceId ?? raw.linked_resource_id) };
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
