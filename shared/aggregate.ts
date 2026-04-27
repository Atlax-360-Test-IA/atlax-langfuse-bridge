/**
 * shared/aggregate.ts — JSONL session aggregation (single source of truth).
 *
 * Used by hooks/langfuse-sync.ts, scripts/reconcile-traces.ts and
 * scripts/validate-traces.ts. Consolidates the duplicated aggregate()
 * functions that previously lived in each script independently.
 */

import { readFileSync } from "node:fs";
import { getPricing } from "./model-pricing";

export interface AggregateResult {
  turns: number;
  totalCost: number;
  start?: string | undefined;
  end?: string | undefined;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  entrypoint?: string | undefined;
  models: Map<string, ModelAgg>;
}

export interface ModelAgg {
  turns: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  serviceTier: string;
}

/**
 * Aggregates usage data from a Claude Code session JSONL file.
 * Parses each line, extracts assistant turns with usage data,
 * and computes per-model and total cost/token metrics.
 */
export function aggregate(path: string): AggregateResult {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  return aggregateLines(lines);
}

/**
 * Core aggregation from pre-split lines (testable without filesystem).
 */
// Allowlist protects Langfuse tags from arbitrary JSONL values (I-4: tags are permanent).
const KNOWN_ENTRYPOINTS = new Set(["cli", "sdk-ts", "sdk-py", "api"]);

export function aggregateLines(lines: string[]): AggregateResult {
  const models = new Map<string, ModelAgg>();
  let turns = 0;
  let totalCost = 0;
  let start: string | undefined;
  let end: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;

  for (const l of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (e["timestamp"] && typeof e["timestamp"] === "string") {
      start ??= e["timestamp"];
      end = e["timestamp"];
    }
    if (e["cwd"] && typeof e["cwd"] === "string" && !cwd) cwd = e["cwd"];
    if (e["gitBranch"] && typeof e["gitBranch"] === "string" && !gitBranch)
      gitBranch = e["gitBranch"];
    if (e["entrypoint"] && typeof e["entrypoint"] === "string" && !entrypoint) {
      entrypoint = KNOWN_ENTRYPOINTS.has(e["entrypoint"])
        ? e["entrypoint"]
        : "cli";
    }
    if (e["type"] !== "assistant") continue;

    const msg = e["message"] as Record<string, unknown> | undefined;
    const u = msg?.["usage"] as Record<string, number> | undefined;
    if (!u) continue;

    turns++;
    const model = (msg?.["model"] as string) ?? "unknown";
    const p = getPricing(model);
    const inputTokens = u["input_tokens"] ?? 0;
    const outputTokens = u["output_tokens"] ?? 0;
    const cacheCreation = u["cache_creation_input_tokens"] ?? 0;
    const cacheRead = u["cache_read_input_tokens"] ?? 0;
    const cost =
      (inputTokens * p.input +
        cacheCreation * p.cacheWrite +
        cacheRead * p.cacheRead +
        outputTokens * p.output) /
      1_000_000;

    totalCost += cost;

    const existing = models.get(model);
    if (!existing) {
      models.set(model, {
        turns: 1,
        cost,
        inputTokens,
        outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        serviceTier:
          typeof u["service_tier"] === "string" ? u["service_tier"] : "",
      });
    } else {
      existing.turns++;
      existing.cost += cost;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheCreationTokens += cacheCreation;
      existing.cacheReadTokens += cacheRead;
      if (typeof u["service_tier"] === "string")
        existing.serviceTier = u["service_tier"];
    }
  }

  return { turns, totalCost, start, end, cwd, gitBranch, entrypoint, models };
}
