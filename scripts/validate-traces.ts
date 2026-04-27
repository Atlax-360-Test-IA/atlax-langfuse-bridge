#!/usr/bin/env bun
/**
 * validate-traces.ts — Reconcile local Claude Code JSONL sessions against
 * Langfuse traces. Prints a table and exits non-zero on drift.
 *
 * Usage:
 *   bun run scripts/validate-traces.ts                # scan last 24h
 *   bun run scripts/validate-traces.ts <path.jsonl>…  # validate specific files
 *   WINDOW_HOURS=72 bun run scripts/validate-traces.ts
 *
 * Uses the same aggregation logic as hooks/langfuse-sync.ts so drift
 * detection matches what the hook would produce on a re-run.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { aggregate } from "../shared/aggregate";
import {
  getTrace as langfuseGetTrace,
  type LangfuseTrace,
} from "../shared/langfuse-client";
import { discoverRecentJsonls } from "../shared/jsonl-discovery";
import { classifyDrift, type DriftStatus } from "../shared/drift";

const HOST = (process.env["LANGFUSE_HOST"] ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const MAX_WINDOW_HOURS = 8760;
const _rawWindow = Number(process.env["WINDOW_HOURS"] ?? "24");
const WINDOW_HOURS =
  Number.isFinite(_rawWindow) && _rawWindow > 0
    ? Math.min(_rawWindow, MAX_WINDOW_HOURS)
    : 24;

// ─── Langfuse fetch ──────────────────────────────────────────────────────────

async function getTrace(id: string): Promise<LangfuseTrace | null> {
  try {
    return await langfuseGetTrace(id, { host: HOST });
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface Row {
  session: string;
  local_turns: number;
  remote_turns: number | string;
  Δturns: number | string;
  local_cost: string;
  remote_cost: string;
  end_local: string;
  end_remote: string;
  status: string;
  path: string;
}

async function main() {
  const PK = process.env["LANGFUSE_PUBLIC_KEY"];
  const SK = process.env["LANGFUSE_SECRET_KEY"];
  if (!PK || !SK) {
    console.error(
      "[validate-traces] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set",
    );
    process.exit(2);
  }

  const argPaths = process.argv.slice(2);
  const paths =
    argPaths.length > 0 ? argPaths : await discoverRecentJsonls(WINDOW_HOURS);

  if (paths.length === 0) {
    console.log(
      `No JSONLs found (args empty, no sessions with mtime < ${WINDOW_HOURS}h)`,
    );
    process.exit(0);
  }

  const rows: Row[] = [];
  for (const p of paths) {
    const sid = p
      .split("/")
      .pop()!
      .replace(/\.jsonl$/, "");
    const tid = `cc-${sid}`;
    const local = aggregate(p);
    const remote = await getTrace(tid);
    const status = classifyDrift({ ...local, end: local.end ?? null }, remote);
    const meta = remote?.metadata ?? null;
    const rTurns: number | null =
      typeof meta?.["turns"] === "number" ? meta["turns"] : null;
    const rCost: number | null =
      typeof meta?.["estimatedCostUSD"] === "number"
        ? meta["estimatedCostUSD"]
        : null;
    const rEnd: string | null =
      typeof meta?.["sessionEnd"] === "string" ? meta["sessionEnd"] : null;

    rows.push({
      session: sid.slice(0, 8),
      local_turns: local.turns,
      remote_turns: rTurns ?? "—",
      Δturns: rTurns === null ? "—" : local.turns - rTurns,
      local_cost: "$" + local.totalCost.toFixed(2),
      remote_cost: rCost === null ? "—" : "$" + rCost.toFixed(2),
      end_local: local.end?.slice(0, 19) ?? "—",
      end_remote: rEnd?.slice(0, 19) ?? "—",
      status,
      path: p.replace(homedir(), "~").slice(0, 60),
    });
  }

  console.table(rows);

  const bad = rows.filter((r) => r.status !== "OK");
  if (bad.length) {
    console.log(`\n⚠️  ${bad.length} session(s) with drift:`);
    for (const r of bad)
      console.log(`  ${r.session}  [${r.status}]  ${r.path}`);
    process.exit(1);
  }
  console.log("\n✅ All sessions in sync");
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[validate-traces] ${err.message}`);
    process.exit(2);
  });
}
