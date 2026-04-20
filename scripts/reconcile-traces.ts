#!/usr/bin/env bun
/**
 * reconcile-traces.ts — Eventual-consistency reconciler for Claude Code JSONLs.
 *
 * Scans recent session JSONLs and detects drift against Langfuse traces
 * (missing trace, turn count mismatch, cost drift, end-timestamp mismatch).
 * For each drifted session, extracts the canonical cwd from the first JSONL
 * entry that carries one and re-executes hooks/langfuse-sync.ts with a
 * synthetic Stop payload. The hook is idempotent-by-traceId so upserts are safe.
 *
 * Designed for periodic execution (systemd timer / launchd / Task Scheduler).
 *
 * Usage:
 *   bun run scripts/reconcile-traces.ts                # default: last 24h
 *   WINDOW_HOURS=72 bun run scripts/reconcile-traces.ts
 *   DRY_RUN=1 bun run scripts/reconcile-traces.ts      # detect only, no repair
 *
 * Exit codes:
 *   0 — scan completed (including when drifts were repaired)
 *   1 — configuration error (missing env vars, etc.)
 *   2 — one or more repairs failed
 */

import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const HOST = (process.env.LANGFUSE_HOST ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const PK = process.env.LANGFUSE_PUBLIC_KEY;
const SK = process.env.LANGFUSE_SECRET_KEY;
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? "24");
const DRY_RUN = process.env.DRY_RUN === "1";
const COST_EPSILON = 0.01;
const EXCLUDE_SESSION = process.env.EXCLUDE_SESSION ?? ""; // skip current session
const HOOK_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "hooks",
  "langfuse-sync.ts",
);

if (!PK || !SK) {
  log("error", "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");

// ─── Structured JSON logging (journalctl-friendly) ───────────────────────────

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "reconcile-traces",
      msg,
      ...extra,
    }) + "\n",
  );
}

// ─── Pricing (mirror of hook) ────────────────────────────────────────────────

const PRICING: Record<
  string,
  { input: number; cacheWrite: number; cacheRead: number; output: number }
> = {
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};
const priceFor = (m: string) => {
  for (const [k, p] of Object.entries(PRICING))
    if (k !== "default" && m.includes(k)) return p;
  return PRICING.default!;
};

// ─── Aggregation (mirror of hook) + cwd extraction ───────────────────────────

interface LocalAgg {
  turns: number;
  totalCost: number;
  start?: string;
  end?: string;
  cwd?: string;
}

function aggregate(path: string): LocalAgg {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  let turns = 0;
  let totalCost = 0;
  let start: string | undefined;
  let end: string | undefined;
  let cwd: string | undefined;

  for (const l of lines) {
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.timestamp) {
      start ??= e.timestamp;
      end = e.timestamp;
    }
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.type !== "assistant") continue;
    const u = e.message?.usage;
    if (!u) continue;
    turns++;
    const model = e.message?.model ?? "unknown";
    const p = priceFor(model);
    totalCost +=
      ((u.input_tokens ?? 0) * p.input +
        (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
        (u.cache_read_input_tokens ?? 0) * p.cacheRead +
        (u.output_tokens ?? 0) * p.output) /
      1_000_000;
  }
  return { turns, totalCost, start, end, cwd };
}

// ─── Langfuse fetch ──────────────────────────────────────────────────────────

async function getTrace(id: string): Promise<any | null> {
  try {
    const r = await fetch(`${HOST}/api/public/traces/${id}`, {
      headers: { Authorization: AUTH },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── Discover JSONLs ─────────────────────────────────────────────────────────

async function discoverRecentJsonls(windowHours: number): Promise<string[]> {
  const root = join(homedir(), ".claude", "projects");
  const cutoff = Date.now() - windowHours * 3_600_000;
  const found: string[] = [];

  let topDirs: string[];
  try {
    topDirs = await readdir(root);
  } catch {
    return [];
  }

  for (const d of topDirs) {
    const projectDir = join(root, d);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(projectDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) found.push(p);
      } catch {
        // ignore
      }
    }
  }
  return found.sort();
}

// ─── Replay hook with reconstructed Stop payload ─────────────────────────────

async function replayHook(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      permission_mode: "default",
      hook_event_name: "Stop",
    });

    const proc = spawn("bun", ["run", HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        log("error", "hook-replay-failed", {
          sessionId,
          code,
          stderr: stderr.slice(0, 200),
        });
        resolve(false);
      } else {
        resolve(true);
      }
    });

    proc.on("error", (err) => {
      log("error", "hook-spawn-error", {
        sessionId,
        error: err.message,
      });
      resolve(false);
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const paths = await discoverRecentJsonls(WINDOW_HOURS);
  log("info", "scan-started", {
    windowHours: WINDOW_HOURS,
    candidates: paths.length,
    dryRun: DRY_RUN,
  });

  let drift = 0;
  let repaired = 0;
  let failed = 0;

  for (const p of paths) {
    const sid = p
      .split("/")
      .pop()!
      .replace(/\.jsonl$/, "");
    if (sid === EXCLUDE_SESSION) continue;

    const tid = `cc-${sid}`;
    const local = aggregate(p);
    const remote = await getTrace(tid);
    const rTurns: number | null = remote?.metadata?.turns ?? null;
    const rCost: number | null = remote?.metadata?.estimatedCostUSD ?? null;
    const rEnd: string | null = remote?.metadata?.sessionEnd ?? null;

    const status = !remote
      ? "MISSING"
      : rTurns !== local.turns
        ? "TURNS_DRIFT"
        : Math.abs((rCost ?? 0) - local.totalCost) > COST_EPSILON
          ? "COST_DRIFT"
          : rEnd !== local.end
            ? "END_DRIFT"
            : "OK";

    if (status === "OK") continue;

    drift++;
    log("warn", "drift-detected", {
      sessionId: sid.slice(0, 8),
      status,
      localTurns: local.turns,
      remoteTurns: rTurns,
      localCost: Number(local.totalCost.toFixed(2)),
      remoteCost: rCost,
      path: p,
    });

    if (DRY_RUN) continue;

    const cwd = local.cwd;
    if (!cwd) {
      log("error", "cwd-missing", { sessionId: sid.slice(0, 8), path: p });
      failed++;
      continue;
    }

    const ok = await replayHook(sid, p, cwd);
    if (ok) {
      repaired++;
      log("info", "repair-ok", { sessionId: sid.slice(0, 8) });
    } else {
      failed++;
    }
  }

  log("info", "scan-completed", {
    candidates: paths.length,
    drift,
    repaired,
    failed,
  });

  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err: Error) => {
  log("error", "unhandled", { error: err.message, stack: err.stack });
  process.exit(2);
});
