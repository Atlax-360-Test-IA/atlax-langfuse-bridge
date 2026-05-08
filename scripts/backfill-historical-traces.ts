#!/usr/bin/env bun
/**
 * backfill-historical-traces.ts — One-shot backfill for cost-tracking schema fix.
 *
 * Re-uploads ALL Claude Code JSONLs found locally to Langfuse, ignoring drift
 * status. Required after the v3 schema fix (PR #45) because reconcile-traces.ts
 * only repairs sessions with detectable drift in turns/cost/end-timestamp —
 * sessions whose remote trace was created with the old schema (calculatedTotalCost = 0)
 * but matches in turns/cost/end appear as "OK" and are never re-uploaded.
 *
 * The hook is idempotent by traceId, so this is safe — it upserts the trace
 * + generations with the correct v3 shape (usageDetails + costDetails).
 *
 * Subagent JSONLs (path contains "/subagents/") are skipped because they share
 * a sessionId with the parent and would cause noise.
 *
 * Usage:
 *   bun run scripts/backfill-historical-traces.ts                 # process all
 *   DRY_RUN=1 bun run scripts/backfill-historical-traces.ts       # list only
 *   THROTTLE_MS=300 bun run scripts/backfill-historical-traces.ts # custom delay
 *
 * Exit codes:
 *   0 — backfill completed (some failures are expected and reported)
 *   1 — configuration error (missing env vars)
 *   2 — fatal error (unhandled rejection)
 */

import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { aggregate } from "../shared/aggregate";
import { emitDegradation } from "../shared/degradation";
import { discoverRecentJsonls } from "../shared/jsonl-discovery";
import { SAFE_SID_RE } from "../shared/validation";

const DRY_RUN = process.env["DRY_RUN"] === "1";

// THROTTLE_MS — delay between hook replays. NaN guard: setTimeout(fn, NaN)
// fires immediately (spec: NaN → 0), which would silently DROP throttling
// and produce a request storm against Langfuse during backfill.
const _rawThrottle = Number(process.env["THROTTLE_MS"] ?? "200");
if (!Number.isFinite(_rawThrottle) || _rawThrottle < 0) {
  process.stderr.write(
    `[backfill] THROTTLE_MS inválido: ${process.env["THROTTLE_MS"]}\n`,
  );
  process.exit(1);
}
const THROTTLE_MS = _rawThrottle;

const WINDOW_HOURS = 8760; // 1 year — covers all historical data
const HOOK_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "hooks",
  "langfuse-sync.ts",
);

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "backfill-historical-traces",
      msg,
      ...extra,
    }) + "\n",
  );
}

async function replayHook(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
): Promise<boolean> {
  return new Promise((resolveProm) => {
    const payload = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      permission_mode: "default",
      hook_event_name: "Stop",
      // S22-A: tag the trace as `source:reconciler` so backfilled sessions
      // are distinguishable from real-time hook emissions in Langfuse.
      _invokedByReconciler: true,
    });

    const proc = spawn(process.execPath, ["run", HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      // LANGFUSE_FORCE_NOW_TIMESTAMP=1 forces the hook to use ingestion `now`
      // instead of the original session timestamps. ClickHouse's
      // ReplacingMergeTree keys events by event_ts, so replaying old sessions
      // with their original timestamps would lose against any subsequent
      // live-hook event. See ARCHITECTURE.md §11 (incident 22-Apr-2026).
      env: { ...process.env, LANGFUSE_FORCE_NOW_TIMESTAMP: "1" },
    });

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

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
          sessionId: sessionId.slice(0, 8),
          code,
          stderr: stderr.slice(0, 200),
        });
        resolveProm(false);
      } else {
        resolveProm(true);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log("error", "hook-spawn-error", {
        sessionId: sessionId.slice(0, 8),
        error: err.message,
      });
      resolveProm(false);
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

async function main() {
  const PK = process.env["LANGFUSE_PUBLIC_KEY"];
  const SK = process.env["LANGFUSE_SECRET_KEY"];
  if (!PK || !SK) {
    log("error", "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
    process.exit(1);
  }

  const allPaths = await discoverRecentJsonls(WINDOW_HOURS, emitDegradation);
  // Skip subagent JSONLs (they share sessionId with parent and cause duplication)
  const paths = allPaths.filter((p) => !p.includes("/subagents/"));

  log("info", "scan-started", {
    windowHours: WINDOW_HOURS,
    totalCandidates: allPaths.length,
    afterSubagentFilter: paths.length,
    skippedSubagents: allPaths.length - paths.length,
    dryRun: DRY_RUN,
    throttleMs: THROTTLE_MS,
  });

  let processed = 0;
  let skippedNoUsage = 0;
  let skippedInvalidSid = 0;
  let skippedNoCwd = 0;
  let uploaded = 0;
  let failed = 0;

  for (const p of paths) {
    processed++;

    if (processed % 50 === 0) {
      log("info", "progress", {
        processed,
        total: paths.length,
        uploaded,
        failed,
      });
    }

    const sid = (p.split("/").pop() ?? "").replace(/\.jsonl$/, "");
    if (!SAFE_SID_RE.test(sid)) {
      skippedInvalidSid++;
      continue;
    }

    let local;
    try {
      local = aggregate(p);
    } catch (err) {
      emitDegradation("backfill:aggregate", err);
      failed++;
      continue;
    }

    if (local.turns === 0) {
      skippedNoUsage++;
      continue;
    }

    if (DRY_RUN) {
      log("info", "would-upload", {
        sessionId: sid.slice(0, 8),
        turns: local.turns,
        cost: Number(local.totalCost.toFixed(4)),
      });
      continue;
    }

    const cwd = local.cwd;
    if (!cwd) {
      log("warn", "cwd-missing", { sessionId: sid.slice(0, 8), path: p });
      skippedNoCwd++;
      continue;
    }

    const ok = await replayHook(sid, p, cwd);
    if (ok) {
      uploaded++;
    } else {
      failed++;
    }

    // Throttle to avoid overwhelming Langfuse ingestion endpoint
    if (THROTTLE_MS > 0 && processed < paths.length) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  log("info", "scan-completed", {
    totalCandidates: paths.length,
    processed,
    skippedNoUsage,
    skippedInvalidSid,
    skippedNoCwd,
    uploaded,
    failed,
  });

  // Non-zero exit if more than 5% failed (sanity check)
  if (failed > paths.length * 0.05) {
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    log("error", "unhandled", { error: err.message, stack: err.stack });
    process.exit(2);
  });
}
