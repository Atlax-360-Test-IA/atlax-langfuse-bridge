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

import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { aggregate } from "../shared/aggregate";
import { classifyDrift, type DriftStatus } from "../shared/drift";
import { emitDegradation } from "../shared/degradation";
import {
  getTrace as langfuseGetTrace,
  type LangfuseTrace,
} from "../shared/langfuse-client";
import { discoverRecentJsonls } from "../shared/jsonl-discovery";

const HOST = (process.env["LANGFUSE_HOST"] ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

const MAX_WINDOW_HOURS = 8760; // 1 year cap — prevents runaway stat calls
const _rawWindow = Number(process.env["WINDOW_HOURS"] ?? "24");
const WINDOW_HOURS =
  Number.isFinite(_rawWindow) && _rawWindow > 0
    ? Math.min(_rawWindow, MAX_WINDOW_HOURS)
    : 24;
const DRY_RUN = process.env["DRY_RUN"] === "1";
const EXCLUDE_SESSION = process.env["EXCLUDE_SESSION"] ?? ""; // skip current session
const HOOK_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "hooks",
  "langfuse-sync.ts",
);

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

// ─── Langfuse fetch ──────────────────────────────────────────────────────────

async function getTrace(id: string): Promise<LangfuseTrace | null> {
  try {
    return await langfuseGetTrace(id, { host: HOST });
  } catch (err) {
    emitDegradation("getTrace:fetch", err);
    return null;
  }
}

// ─── Replay hook with reconstructed Stop payload ─────────────────────────────

// Safe session ID: only alphanumeric, hyphens, underscores (UUID format).
// Prevents path traversal if the filename ever influences a downstream path.
export const SAFE_SID_RE = /^[0-9a-zA-Z_-]+$/;

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

    // Use the bun binary currently executing the reconciler. systemd user
    // services don't source ~/.zshrc, so relying on PATH would fail.
    const proc = spawn(process.execPath, ["run", HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    // C3: kill the subprocess if it doesn't finish within 30 s.
    // Without this guard the reconciler can hang indefinitely when the hook
    // stalls (e.g. Langfuse unreachable + no timeout on the hook side).
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      log("error", "hook-replay-timeout", {
        sessionId: sessionId.slice(0, 8),
      });
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
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
  const PK = process.env["LANGFUSE_PUBLIC_KEY"];
  const SK = process.env["LANGFUSE_SECRET_KEY"];
  if (!PK || !SK) {
    log("error", "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
    process.exit(1);
  }

  const paths = await discoverRecentJsonls(WINDOW_HOURS, emitDegradation);
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

    // C4: reject filenames that don't match the expected UUID-like pattern.
    // A malformed filename (e.g. "../secret") could propagate as a trace ID
    // or path component in downstream calls.
    if (!SAFE_SID_RE.test(sid)) {
      log("warn", "skipping-invalid-sid", { path: p });
      continue;
    }

    if (sid === EXCLUDE_SESSION) continue;

    const tid = `cc-${sid}`;
    const local = aggregate(p);

    // Skip sessions with no assistant usage — they never generated a trace
    // (the hook itself exits early on empty usage). Reporting them as drift
    // is noise.
    if (local.turns === 0) continue;

    const remote = await getTrace(tid);
    const localForDrift = { ...local, end: local.end ?? null };
    const status = classifyDrift(localForDrift, remote);

    if (status === "OK") continue;

    const remMeta = remote?.metadata ?? null;
    drift++;
    log("warn", "drift-detected", {
      sessionId: sid.slice(0, 8),
      status,
      localTurns: local.turns,
      remoteTurns:
        typeof remMeta?.["turns"] === "number" ? remMeta["turns"] : null,
      localCost: Number(local.totalCost.toFixed(2)),
      remoteCost:
        typeof remMeta?.["estimatedCostUSD"] === "number"
          ? remMeta["estimatedCostUSD"]
          : null,
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

if (import.meta.main) {
  main().catch((err: Error) => {
    log("error", "unhandled", { error: err.message, stack: err.stack });
    process.exit(2);
  });
}
