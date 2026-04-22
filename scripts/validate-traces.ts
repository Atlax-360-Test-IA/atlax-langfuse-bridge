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

import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPricing } from "../shared/model-pricing";

const HOST = (process.env.LANGFUSE_HOST ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const PK = process.env.LANGFUSE_PUBLIC_KEY;
const SK = process.env.LANGFUSE_SECRET_KEY;

if (!PK || !SK) {
  console.error(
    "[validate-traces] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set",
  );
  process.exit(2);
}

const AUTH = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? "24");
const COST_EPSILON = 0.01;

// ─── Aggregation (mirror of hook) ────────────────────────────────────────────

interface LocalAgg {
  turns: number;
  totalCost: number;
  start?: string;
  end?: string;
  models: string[];
}

function aggregate(path: string): LocalAgg {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const models = new Map<string, { turns: number; cost: number }>();
  let start: string | undefined;
  let end: string | undefined;
  let turns = 0;

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
    if (e.type !== "assistant") continue;
    const u = e.message?.usage;
    if (!u) continue;
    turns++;
    const model = e.message?.model ?? "unknown";
    const p = getPricing(model);
    const cost =
      ((u.input_tokens ?? 0) * p.input +
        (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
        (u.cache_read_input_tokens ?? 0) * p.cacheRead +
        (u.output_tokens ?? 0) * p.output) /
      1_000_000;
    const cur = models.get(model) ?? { turns: 0, cost: 0 };
    cur.turns++;
    cur.cost += cost;
    models.set(model, cur);
  }
  const totalCost = [...models.values()].reduce((s, m) => s + m.cost, 0);
  return { turns, totalCost, start, end, models: [...models.keys()] };
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

main().catch((err) => {
  console.error(`[validate-traces] ${err.message}`);
  process.exit(2);
});
