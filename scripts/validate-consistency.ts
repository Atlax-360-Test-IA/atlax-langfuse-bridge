#!/usr/bin/env bun
/**
 * validate-consistency.ts — Validación funcional intensiva de consistencia.
 *
 * Lee local (JSONLs) + remoto (Langfuse) + opcional (Anthropic Admin API)
 * y reporta drift, gaps de tag schema, salud del bridge y divergencia coste.
 *
 * NO modifica nada — solo lee. Recreado tras recovery 2026-05-08
 * (versión original en /tmp/atlax-validation/ se perdió al reiniciar WSL).
 *
 * Uso:
 *   set -a; source ~/.atlax-ai/reconcile.env; set +a
 *   bun run scripts/validate-consistency.ts
 *
 * Notas operativas:
 *   - Langfuse v3 ingestion pipeline tiene latencia ~12-15s
 *     (API → Redis → Worker → ClickHouse). NO consultar trace recién creado
 *     antes de ese tiempo o saldrá vacío.
 *   - cost_report Anthropic requiere group_by[]=description para que el
 *     campo `model` venga poblado en cada result row (ver PR #68).
 */

import { aggregate } from "../shared/aggregate";
import { discoverRecentJsonls } from "../shared/jsonl-discovery";
import { classifyDrift } from "../shared/drift";
import { SAFE_SID_RE } from "../shared/validation";

// ─── Config ─────────────────────────────────────────────────────────────────

const HOST = process.env["LANGFUSE_HOST"];
const PK = process.env["LANGFUSE_PUBLIC_KEY"];
const SK = process.env["LANGFUSE_SECRET_KEY"];
const ADMIN_KEY = process.env["ANTHROPIC_ADMIN_API_KEY"];

if (!HOST || !PK || !SK) {
  process.stderr.write(
    "Faltan LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY\n",
  );
  process.exit(2);
}

const AUTH = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
const WINDOW_HOURS = Number(process.env["WINDOW_HOURS"] ?? "168"); // 7d default

// ─── Logging ─────────────────────────────────────────────────────────────────

const COLOR = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let issues = 0;
let warnings = 0;

const pass = (msg: string) =>
  console.log(`  ${COLOR.green}✓${COLOR.reset} ${msg}`);
const fail = (msg: string) => {
  console.log(`  ${COLOR.red}✗${COLOR.reset} ${msg}`);
  issues++;
};
const warn = (msg: string) => {
  console.log(`  ${COLOR.yellow}⚠${COLOR.reset} ${msg}`);
  warnings++;
};
const info = (msg: string) =>
  console.log(`  ${COLOR.cyan}ℹ${COLOR.reset} ${msg}`);
const section = (title: string) =>
  console.log(`\n${COLOR.bold}━━ ${title} ━━${COLOR.reset}`);

// ─── Langfuse helpers ───────────────────────────────────────────────────────

async function fetchTraces(params: Record<string, string>): Promise<{
  data: Array<{
    id: string;
    name: string | null;
    timestamp: string;
    userId: string | null;
    sessionId: string | null;
    tags: string[];
    metadata: Record<string, unknown> | null;
  }>;
  meta: { totalItems: number };
}> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${HOST}/api/public/traces?${qs}`, {
    headers: { Authorization: AUTH },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Langfuse ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    data: Array<{
      id: string;
      name: string | null;
      timestamp: string;
      userId: string | null;
      sessionId: string | null;
      tags: string[];
      metadata: Record<string, unknown> | null;
    }>;
    meta: { totalItems: number };
  }>;
}

async function fetchTraceById(id: string): Promise<{
  metadata?: Record<string, unknown> | null;
} | null> {
  const res = await fetch(
    `${HOST}/api/public/traces/${encodeURIComponent(id)}`,
    { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Langfuse ${res.status}`);
  return res.json() as Promise<{ metadata?: Record<string, unknown> | null }>;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n${COLOR.bold}=== Atlax Bridge — Validación de consistencia ===${COLOR.reset}`,
  );
  console.log(`Host:    ${HOST}`);
  console.log(`Window:  ${WINDOW_HOURS}h`);
  console.log(
    `Admin:   ${ADMIN_KEY ? COLOR.green + "configured" + COLOR.reset : COLOR.yellow + "not set (skipping cost reconciliation)" + COLOR.reset}`,
  );

  // 1. Inventario
  section("1. Inventario Langfuse");
  let totalTraces = 0;
  const byName = new Map<string, number>();
  const byCostSource = new Map<string, number>();
  let ccTraces = 0;
  let bridgeHealth = 0;
  let page = 1;
  while (true) {
    const res = await fetchTraces({ limit: "100", page: String(page) });
    if (page === 1) totalTraces = res.meta.totalItems;
    for (const t of res.data) {
      const n = t.name ?? "<null>";
      byName.set(n, (byName.get(n) ?? 0) + 1);
      const cs =
        t.tags.find((x) => x.startsWith("cost-source:"))?.split(":")[1] ??
        "<none>";
      byCostSource.set(cs, (byCostSource.get(cs) ?? 0) + 1);
      if (t.id.startsWith("cc-")) ccTraces++;
      if (n === "bridge-health") bridgeHealth++;
    }
    if (res.data.length < 100) break;
    page++;
    if (page > 50) {
      warn(`Pagination cap (50 pages) reached`);
      break;
    }
  }
  info(`Total traces: ${totalTraces}`);
  info(`cc-* (hook): ${ccTraces}`);
  info(`bridge-health: ${bridgeHealth}`);
  console.log(`  ${COLOR.bold}Por cost-source:${COLOR.reset}`);
  for (const [k, v] of [...byCostSource.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }

  // 2. JSONLs locales
  section(`2. JSONLs locales (${WINDOW_HOURS}h)`);
  const paths = await discoverRecentJsonls(WINDOW_HOURS);
  let withMessages = 0;
  let totalCostUSD = 0;
  const modelsUsed = new Set<string>();
  for (const p of paths) {
    try {
      const agg = aggregate(p);
      if (agg.turns > 0) {
        withMessages++;
        totalCostUSD += agg.totalCost;
        for (const m of agg.models.keys()) modelsUsed.add(m);
      }
    } catch {
      /* ignore — degradation logged inside aggregate */
    }
  }
  info(`JSONLs descubiertos: ${paths.length}`);
  info(`Con tráfico billable: ${withMessages}`);
  info(`Coste estimado total: $${totalCostUSD.toFixed(4)}`);
  info(`Modelos: ${[...modelsUsed].join(", ") || "<none>"}`);

  // 3. Drift
  section("3. Drift detection");
  const byStatus = new Map<string, number>();
  const driftDetails: string[] = [];
  for (const p of paths) {
    const sid = (p.split("/").pop() ?? "").replace(/\.jsonl$/, "");
    if (!SAFE_SID_RE.test(sid)) continue;
    const local = aggregate(p);
    if (local.turns === 0) continue;
    let remote;
    try {
      remote = await fetchTraceById(`cc-${sid}`);
    } catch {
      continue;
    }
    const status = classifyDrift({ ...local, end: local.end ?? null }, remote);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (status !== "OK") {
      const meta = remote?.metadata ?? null;
      const rTurns =
        typeof meta?.["turns"] === "number" ? (meta["turns"] as number) : null;
      driftDetails.push(
        `${status} ${sid.slice(0, 40)} local=${local.turns} remote=${rTurns}`,
      );
    }
  }
  for (const [s, c] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    if (s === "OK") pass(`${s}: ${c}`);
    else warn(`${s}: ${c}`);
  }
  for (const d of driftDetails.slice(0, 5)) console.log(`    ${d}`);

  // 4. Bridge-health más reciente
  section("4. Bridge-health");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const bh = await fetchTraceById(`bridge-reconciler-${today}`);
    if (bh) {
      const m = bh.metadata ?? {};
      const c = m["candidates"] as number;
      const d = m["drift"] as number;
      const r = m["repaired"] as number;
      const f = m["failed"] as number;
      info(`Hoy: candidates=${c} drift=${d} repaired=${r} failed=${f}`);
      if (f === 0 && ((m["degradationCount"] as number) ?? 0) === 0)
        pass(`status:ok`);
      else
        fail(
          `status:degraded — failed=${f} degradations=${m["degradationCount"]}`,
        );
    } else {
      warn(`Sin bridge-health para hoy (cron puede no haber corrido aún)`);
    }
  } catch (err) {
    warn(`Error consultando bridge-health: ${err}`);
  }

  // 5. Cost reconciliation (opcional)
  if (ADMIN_KEY) {
    section("5. Cost reconciliation vs Anthropic");
    const now = new Date();
    const startDay = new Date(now);
    startDay.setUTCDate(startDay.getUTCDate() - 7);
    startDay.setUTCHours(0, 0, 0, 0);
    const endDay = new Date(now);
    endDay.setUTCHours(0, 0, 0, 0);
    endDay.setUTCDate(endDay.getUTCDate() + 1);
    const startingAt = startDay.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endingAt = endDay.toISOString().replace(/\.\d{3}Z$/, "Z");
    const qs = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
    });
    qs.append("group_by[]", "description");
    try {
      const res = await fetch(
        `https://api.anthropic.com/v1/organizations/cost_report?${qs}`,
        {
          headers: {
            "x-api-key": ADMIN_KEY,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        warn(
          `Anthropic API ${res.status}: ${(await res.text()).slice(0, 100)}`,
        );
      } else {
        const report = (await res.json()) as {
          data: Array<{
            results: Array<{
              amount: string;
              description: string;
              model?: string;
            }>;
          }>;
        };
        const byModel = new Map<string, number>();
        for (const day of report.data) {
          for (const r of day.results) {
            const cost = Number(r.amount);
            if (!Number.isFinite(cost) || !r.model) continue;
            byModel.set(r.model, (byModel.get(r.model) ?? 0) + cost);
          }
        }
        const apiTotal = [...byModel.values()].reduce((a, b) => a + b, 0);
        info(`Coste real (Anthropic, 7d): $${apiTotal.toFixed(2)}`);
        info(`Coste estimado bridge (7d): $${totalCostUSD.toFixed(2)}`);
        if (byModel.size > 0) {
          for (const [m, c] of [...byModel.entries()].sort(
            (a, b) => b[1] - a[1],
          )) {
            console.log(`    ${m.padEnd(40)} $${c.toFixed(2)}`);
          }
        }
      }
    } catch (err) {
      warn(`Error consultando Anthropic: ${err}`);
    }
  }

  // ── Resumen ──
  section("Resumen");
  if (issues === 0 && warnings === 0) {
    console.log(`\n  ${COLOR.green}${COLOR.bold}✓ TODO OK${COLOR.reset}\n`);
  } else if (issues === 0) {
    console.log(
      `\n  ${COLOR.yellow}${COLOR.bold}⚠ ${warnings} warnings${COLOR.reset}\n`,
    );
  } else {
    console.log(
      `\n  ${COLOR.red}${COLOR.bold}✗ ${issues} issues, ${warnings} warnings${COLOR.reset}\n`,
    );
  }
  process.exit(issues === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${COLOR.red}FATAL: ${err}${COLOR.reset}`);
  process.exit(2);
});
