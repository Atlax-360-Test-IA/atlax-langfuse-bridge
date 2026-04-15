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

// ─── Types ───────────────────────────────────────────────────────────────────

interface StopEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
}

interface JournalEntry {
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

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  serviceTier: string;
  turns: number;
}

// ─── Model pricing (USD per million tokens, April 2026) ──────────────────────

const MODEL_PRICING: Record<
  string,
  { input: number; cacheWrite: number; cacheRead: number; output: number }
> = {
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

function getPricing(model: string) {
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && model.includes(key)) return pricing;
  }
  return MODEL_PRICING["default"]!;
}

function calcCost(
  usage: JournalEntry["message"]["usage"],
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

function getDevIdentity(): string {
  // 1. Explicit override
  if (process.env.LANGFUSE_USER_ID) return process.env.LANGFUSE_USER_ID;
  if (process.env.CLAUDE_DEV_NAME) return process.env.CLAUDE_DEV_NAME;

  // 2. Git config email — best automatic option, already set on every dev machine
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (email) return email;
  } catch {
    // ignore
  }

  // 3. OS username as fallback
  return os.userInfo().username;
}

// ─── Project identification (automatic from cwd + git remote) ────────────────

function getProjectName(cwd: string): string {
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
  } catch {
    // ignore
  }
  // Fallback to directory basename
  return path.basename(cwd);
}

// ─── Billing tier detection ───────────────────────────────────────────────────

type BillingTier =
  | "vertex-gcp"
  | "anthropic-priority-overage"
  | "anthropic-team-standard";

function getBillingTier(serviceTier?: string): BillingTier {
  if (
    process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
    process.env.CLAUDE_CODE_USE_VERTEX === "true"
  ) {
    return "vertex-gcp";
  }
  if (serviceTier === "priority") return "anthropic-priority-overage";
  return "anthropic-team-standard";
}

// ─── OS detection ────────────────────────────────────────────────────────────

type OSName = "linux" | "wsl" | "macos" | "windows";

function detectOS(): OSName {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  try {
    const version = readFileSync("/proc/version", "utf-8").toLowerCase();
    if (version.includes("microsoft")) return "wsl";
  } catch {
    // ignore
  }
  return "linux";
}

// ─── Langfuse REST ingestion ──────────────────────────────────────────────────

async function sendToLangfuse(batch: unknown[]): Promise<void> {
  const host = (
    process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com"
  ).replace(/\/$/, "");
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

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
  } catch {
    process.exit(0);
  }

  const { session_id, transcript_path, cwd } = event;
  if (!transcript_path || !session_id) process.exit(0);

  // Parse JSONL
  let lines: string[];
  try {
    lines = readFileSync(transcript_path, "utf-8").split("\n").filter(Boolean);
  } catch {
    process.exit(0);
  }

  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // skip malformed lines
    }
  }

  // Aggregate usage
  const usageByModel = new Map<string, ModelUsage>();
  let sessionStart: string | undefined;
  let sessionEnd: string | undefined;
  let entrypoint: string | undefined;
  let gitBranch: string | undefined;
  let turnCount = 0;

  for (const entry of entries) {
    if (entry.timestamp) {
      sessionStart ??= entry.timestamp;
      sessionEnd = entry.timestamp;
    }
    if (entry.entrypoint && !entrypoint) entrypoint = entry.entrypoint;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
    if (entry.type !== "assistant") continue;

    const usage = entry.message?.usage;
    const model = entry.message?.model ?? "unknown";
    if (!usage) continue;

    turnCount++;
    const cost = calcCost(usage, model);
    const tier = usage.service_tier ?? "";

    const existing = usageByModel.get(model);
    if (!existing) {
      usageByModel.set(model, {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        costUSD: cost,
        serviceTier: tier,
        turns: 1,
      });
    } else {
      existing.inputTokens += usage.input_tokens ?? 0;
      existing.outputTokens += usage.output_tokens ?? 0;
      existing.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      existing.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      existing.costUSD += cost;
      if (tier) existing.serviceTier = tier;
      existing.turns++;
    }
  }

  if (usageByModel.size === 0) process.exit(0); // no billable usage

  // Determine billing context
  const costEntries = [...usageByModel.values()];
  const totalCost = costEntries.reduce((s, m) => s + m.costUSD, 0);
  const dominantTier = costEntries.sort((a, b) => b.costUSD - a.costUSD)[0]
    ?.serviceTier;
  const billingTier = getBillingTier(dominantTier);

  const devEmail = getDevIdentity();
  const projectName = getProjectName(cwd);
  const osName = detectOS();
  const now = new Date().toISOString();
  const traceId = `cc-${session_id}`;

  // ── Build Langfuse batch ──
  const batch: unknown[] = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
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
        ],
        metadata: {
          project: projectName,
          cwd,
          billingTier,
          os: osName,
          entrypoint: entrypoint ?? "cli",
          gitBranch: gitBranch ?? null,
          turns: turnCount,
          sessionStart: sessionStart ?? null,
          sessionEnd: sessionEnd ?? null,
          estimatedCostUSD: Number(totalCost.toFixed(6)),
          modelsUsed: [...usageByModel.keys()],
        },
        input: { turns: turnCount },
        output: { estimatedCostUSD: totalCost },
      },
    },
  ];

  // One generation per model
  for (const [model, usage] of usageByModel) {
    const safeModelId = model.replace(/[^a-z0-9-]/gi, "-");
    batch.push({
      id: randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        id: `${traceId}-${safeModelId}`,
        traceId,
        name: model,
        model,
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total:
            usage.inputTokens +
            usage.outputTokens +
            usage.cacheCreationTokens +
            usage.cacheReadTokens,
          unit: "TOKENS",
        },
        costDetails: {
          estimatedUSD: Number(usage.costUSD.toFixed(6)),
        },
        metadata: {
          cacheCreationTokens: usage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens,
          serviceTier: usage.serviceTier,
          billingTier,
          turns: usage.turns,
        },
      },
    });
  }

  await sendToLangfuse(batch);
}

main().catch((err: Error) => {
  process.stderr.write(`[langfuse-sync] Error no controlado: ${err.message}\n`);
  process.exit(0); // siempre exit 0 — no bloquear Claude Code
});
