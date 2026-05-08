#!/usr/bin/env bun
/**
 * langfuse-sync.ts — Atlax360 Claude Code → Langfuse hook
 *
 * Se ejecuta via hook Stop de Claude Code. Recibe por stdin:
 *   { session_id, transcript_path, cwd, hook_event_name, ... }
 *
 * Sin dependencias externas — solo APIs built-in de Bun/Node.
 * Exit code 0 siempre: nunca bloquea Claude Code.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { getPricing } from "../shared/model-pricing";
import { aggregateLines } from "../shared/aggregate";
import { emitDegradation } from "../shared/degradation";
import { isSafeHost } from "../shared/langfuse-client";
import { safeFilePath } from "../shared/validation";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StopEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  /** Set by reconciler when replaying a drifted session (S22-A). */
  _invokedByReconciler?: boolean;
}

export interface JournalEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  durationMs?: number;
  message?: {
    role?: string;
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      service_tier?: string;
    };
  };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  serviceTier: string;
  turns: number;
}

export function calcCost(
  usage: NonNullable<JournalEntry["message"]>["usage"],
  model: string,
): number {
  if (!usage) return 0;
  const p = getPricing(model);
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.output_tokens ?? 0) * p.output) /
    1_000_000
  );
}

// ─── Developer identification (automatic, no per-dev config needed) ──────────

export function getDevIdentity(): string {
  // 1. Explicit override
  if (process.env["LANGFUSE_USER_ID"]) return process.env["LANGFUSE_USER_ID"];
  if (process.env["CLAUDE_DEV_NAME"]) return process.env["CLAUDE_DEV_NAME"];

  // 2. Git config email — best automatic option, already set on every dev machine
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (email) return email;
  } catch (err) {
    emitDegradation("getDevIdentity:git-config", err);
  }

  // 3. OS username as fallback
  return os.userInfo().username;
}

// ─── Project identification (automatic from cwd + git remote) ────────────────

export function getProjectName(cwd: string): string {
  // Try git remote — gives canonical org/repo name
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    // Extract "org/repo" from SSH or HTTPS URL
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  } catch (err) {
    emitDegradation("getProjectName:git-remote", err);
  }
  // Fallback to directory basename
  return path.basename(cwd);
}

// ─── Billing tier detection ───────────────────────────────────────────────────

export type BillingTier =
  | "vertex-gcp"
  | "anthropic-priority-overage"
  | "anthropic-team-standard";

export function getBillingTier(serviceTier?: string): BillingTier {
  if (
    process.env["CLAUDE_CODE_USE_VERTEX"] === "1" ||
    process.env["CLAUDE_CODE_USE_VERTEX"] === "true"
  ) {
    return "vertex-gcp";
  }
  if (serviceTier === "priority") return "anthropic-priority-overage";
  return "anthropic-team-standard";
}

// ─── Deterministic tier from ~/.atlax-ai/tier.json ───────────────────────────
// Written by scripts/detect-tier.ts (called from the Claude Code statusline).
// Complements the heuristic above with an unambiguous source of truth for
// which Anthropic surface the session was authenticated against.

export interface TierFile {
  tier: "vertex-gcp" | "api-direct" | "seat-team" | "unknown";
  source: "env-vertex" | "env-api-key" | "oauth" | "none";
  account: string | null;
  detectedAt: string;
}

const VALID_TIERS = new Set([
  "vertex-gcp",
  "api-direct",
  "seat-team",
  "unknown",
]);
const VALID_SOURCES = new Set(["env-vertex", "env-api-key", "oauth", "none"]);

export function readTierFile(): TierFile | null {
  try {
    const p = path.join(os.homedir(), ".atlax-ai", "tier.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (
      !VALID_TIERS.has(raw["tier"] as string) ||
      !VALID_SOURCES.has(raw["source"] as string)
    ) {
      emitDegradation(
        "readTierFile:invalid-shape",
        new Error(`unexpected tier=${raw["tier"]} source=${raw["source"]}`),
      );
      return null;
    }
    return raw as unknown as TierFile;
  } catch (err) {
    emitDegradation("readTierFile:read", err);
    return null;
  }
}

// ─── OS detection ────────────────────────────────────────────────────────────

export type OSName = "linux" | "wsl" | "macos" | "windows";

export function detectOS(): OSName {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  try {
    const version = readFileSync("/proc/version", "utf-8").toLowerCase();
    if (version.includes("microsoft")) return "wsl";
  } catch (err) {
    emitDegradation("detectOS:proc-version", err);
  }
  return "linux";
}

// ─── Langfuse REST ingestion ──────────────────────────────────────────────────

async function sendToLangfuse(batch: unknown[]): Promise<void> {
  const rawHost = process.env["LANGFUSE_HOST"] ?? "https://cloud.langfuse.com";
  if (!isSafeHost(rawHost)) {
    await emitDegradation(
      "sendToLangfuse:unsafe-host",
      new Error(
        `LANGFUSE_HOST blocked (must be https:// or http://localhost): ${rawHost}`,
      ),
    );
    return;
  }
  const host = rawHost.replace(/\/$/, "");
  const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = process.env["LANGFUSE_SECRET_KEY"];

  if (!publicKey || !secretKey) {
    process.stderr.write(
      "[langfuse-sync] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY no configurados\n",
    );
    return;
  }

  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
    "base64",
  );

  const res = await fetch(`${host}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    process.stderr.write(
      `[langfuse-sync] Error Langfuse ${res.status}: ${body.slice(0, 200)}\n`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let event: StopEvent;
  try {
    event = JSON.parse(raw) as StopEvent;
  } catch (err) {
    emitDegradation("main:parse-stop-event", err);
    process.exit(0);
  }

  // Type-validate the StopEvent before consuming its fields. The `as StopEvent`
  // cast does NOT validate at runtime — without this guard a malformed Stop
  // event (e.g. session_id as object) would propagate corrupted data to
  // Langfuse. I-1: never throw, just exit 0 + emit degradation.
  if (
    typeof event.session_id !== "string" ||
    typeof event.transcript_path !== "string" ||
    typeof event.cwd !== "string"
  ) {
    emitDegradation(
      "main:invalid-stop-event",
      new Error(
        `unexpected Stop event shape: session_id=${typeof event.session_id} transcript_path=${typeof event.transcript_path} cwd=${typeof event.cwd}`,
      ),
    );
    process.exit(0);
  }

  const { session_id, transcript_path, cwd, _invokedByReconciler } = event;
  if (!transcript_path || !session_id) process.exit(0);

  // Confine transcript_path to ~/.claude/projects/ — defense against a
  // compromised parent process injecting an arbitrary path via stdin.
  // ATLAX_TRANSCRIPT_ROOT_OVERRIDE is reserved for the test suite to point
  // at fixtures outside HOME; production code never sets it.
  let safeTranscriptPath: string;
  try {
    const overrideRoot = process.env["ATLAX_TRANSCRIPT_ROOT_OVERRIDE"];
    const safeRoot =
      overrideRoot && overrideRoot.length > 0
        ? overrideRoot
        : path.join(os.homedir(), ".claude", "projects");
    safeTranscriptPath = safeFilePath(safeRoot, transcript_path);
  } catch (err) {
    emitDegradation("main:unsafe-transcript-path", err);
    process.exit(0);
  }

  // Parse JSONL
  let lines: string[];
  try {
    lines = readFileSync(safeTranscriptPath, "utf-8")
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    emitDegradation("main:read-transcript", err);
    process.exit(0);
  }

  // Aggregate usage via shared/aggregate (single source of truth for token/cost logic)
  const agg = aggregateLines(lines);

  if (agg.models.size === 0) process.exit(0); // no billable usage

  // Determine billing context
  const costEntries = [...agg.models.values()];
  const totalCost = agg.totalCost;
  const dominantTier = costEntries.sort((a, b) => b.cost - a.cost)[0]
    ?.serviceTier;
  const billingTier = getBillingTier(dominantTier);

  const sessionStart = agg.start;
  const sessionEnd = agg.end;
  const entrypoint = agg.entrypoint;
  const gitBranch = agg.gitBranch;
  const turnCount = agg.turns;

  // Prefer cwd from first JSONL entry (captures the real session origin),
  // fall back to Stop event cwd. Fixes tag contamination when Claude Code
  // runs the hook from a different working directory than where the
  // session actually started.
  const effectiveCwd = agg.cwd ?? cwd;

  const devEmail = getDevIdentity();
  const projectName = getProjectName(effectiveCwd);
  const osName = detectOS();
  const tierFile = readTierFile();
  const now = new Date().toISOString();
  // Use real session timestamps for trace/generation ordering in Langfuse.
  // Falls back to `now` only if the JSONL had no timestamps at all.
  // LANGFUSE_FORCE_NOW_TIMESTAMP=1 overrides session timestamps with `now`,
  // required during backfill operations: ClickHouse uses ReplacingMergeTree
  // keyed by event_ts, so replaying older sessions with their original
  // session timestamps would lose against any subsequent live-hook event.
  const forceNowTs = process.env["LANGFUSE_FORCE_NOW_TIMESTAMP"] === "1";
  const traceTimestamp = forceNowTs ? now : (sessionStart ?? now);
  const generationTimestamp = forceNowTs ? now : (sessionEnd ?? now);
  const traceId = `cc-${session_id}`;

  // ── Build Langfuse batch ──
  const batch: unknown[] = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: traceTimestamp,
      body: {
        id: traceId,
        timestamp: traceTimestamp,
        name: "claude-code-session",
        userId: devEmail,
        sessionId: session_id,
        tags: [
          `project:${projectName}`,
          `billing:${billingTier}`,
          `os:${osName}`,
          `entrypoint:${entrypoint ?? "cli"}`,
          ...(gitBranch ? [`branch:${gitBranch}`] : []),
          ...(billingTier === "vertex-gcp"
            ? ["infra:gcp"]
            : ["infra:anthropic"]),
          `tier:${tierFile?.tier ?? "unknown"}`,
          `tier-source:${tierFile?.source ?? "none"}`,
          "cost-source:estimated",
          ...(_invokedByReconciler ? ["source:reconciler"] : []),
        ],
        metadata: {
          project: projectName,
          cwd: effectiveCwd,
          billingTier,
          tier: tierFile?.tier ?? null,
          tierSource: tierFile?.source ?? null,
          tierAccount: tierFile?.account ?? null,
          os: osName,
          entrypoint: entrypoint ?? "cli",
          gitBranch: gitBranch ?? null,
          turns: turnCount,
          sessionStart: sessionStart ?? null,
          sessionEnd: sessionEnd ?? null,
          estimatedCostUSD: Number(totalCost.toFixed(6)),
          modelsUsed: [...agg.models.keys()],
          costSource: "estimated",
        },
        input: { turns: turnCount },
        output: { estimatedCostUSD: totalCost },
      },
    },
  ];

  // One generation per model
  for (const [model, usage] of agg.models) {
    const safeModelId = model.replace(/[^a-z0-9-]/gi, "-");
    const pricing = getPricing(model);
    batch.push({
      id: randomUUID(),
      type: "generation-create",
      timestamp: generationTimestamp,
      body: {
        id: `${traceId}-${safeModelId}`,
        traceId,
        name: model,
        model,
        usageDetails: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheCreationTokens,
          total:
            usage.inputTokens +
            usage.outputTokens +
            usage.cacheCreationTokens +
            usage.cacheReadTokens,
        },
        costDetails: {
          input: Number(
            ((usage.inputTokens * pricing.input) / 1_000_000).toFixed(8),
          ),
          output: Number(
            ((usage.outputTokens * pricing.output) / 1_000_000).toFixed(8),
          ),
          cache_read_input_tokens: Number(
            ((usage.cacheReadTokens * pricing.cacheRead) / 1_000_000).toFixed(
              8,
            ),
          ),
          cache_creation_input_tokens: Number(
            (
              (usage.cacheCreationTokens * pricing.cacheWrite) /
              1_000_000
            ).toFixed(8),
          ),
          total: Number(usage.cost.toFixed(8)),
        },
        metadata: {
          serviceTier: usage.serviceTier,
          billingTier,
          turns: usage.turns,
        },
      },
    });
  }

  await sendToLangfuse(batch);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    process.stderr.write(
      `[langfuse-sync] Error no controlado: ${err.message}\n`,
    );
    process.exit(0); // siempre exit 0 — no bloquear Claude Code
  });
}
