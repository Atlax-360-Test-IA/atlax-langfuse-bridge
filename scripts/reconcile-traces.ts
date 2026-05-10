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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { aggregate } from "../shared/aggregate";
import { classifyDrift, type DriftStatus } from "../shared/drift";
import { emitDegradation, type DegradationEntry } from "../shared/degradation";
import {
  getTrace as langfuseGetTrace,
  getGenerationsForTrace as langfuseGetGenerationsForTrace,
  isSafeHost,
  type LangfuseTrace,
} from "../shared/langfuse-client";
import { discoverRecentJsonls } from "../shared/jsonl-discovery";
import {
  getCostReport,
  sumCostByModel,
} from "../shared/anthropic-admin-client";
import { SAFE_SID_RE } from "../shared/validation";

// Re-export for tests and downstream consumers that historically imported
// from this module (kept stable as a public API surface).
export { SAFE_SID_RE };

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

// S18-D: umbral de divergencia entre coste estimado local y coste real Anthropic.
// >5% sugiere drift sistémico (modelo nuevo con pricing incorrecto, fórmula
// errónea, gap entre lo que el JSONL reporta y lo que Anthropic factura).
// Override vía COST_DIVERGENCE_THRESHOLD si el ruido normal lo justifica.
export const DEFAULT_COST_DIVERGENCE_THRESHOLD = 0.05;
const _rawThreshold = Number(
  process.env["COST_DIVERGENCE_THRESHOLD"] ?? DEFAULT_COST_DIVERGENCE_THRESHOLD,
);
const COST_DIVERGENCE_THRESHOLD =
  Number.isFinite(_rawThreshold) && _rawThreshold > 0
    ? _rawThreshold
    : DEFAULT_COST_DIVERGENCE_THRESHOLD;
// Coste mínimo (USD) para emitir comparación. Modelos con <$0.10 de tráfico
// generan ratios ruidosos que no aportan señal.
const COST_COMPARE_MIN_USD = 0.1;

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

export async function getTrace(id: string): Promise<LangfuseTrace | null> {
  try {
    return await langfuseGetTrace(id, { host: HOST });
  } catch (err) {
    emitDegradation("getTrace:fetch", err);
    return null;
  }
}

export async function getGenerationCost(
  traceId: string,
): Promise<number | null> {
  try {
    return await langfuseGetGenerationsForTrace(traceId, { host: HOST });
  } catch (err) {
    emitDegradation("getGenerationCost:fetch", err);
    return null;
  }
}

// ─── S18-B/D: comparación coste estimado vs. real (Anthropic Admin API) ─────

/**
 * Normaliza un model ID al "family key" para agrupación. Dos sesiones con
 * `claude-haiku-4-5-20251001` y `claude-haiku-4-5` deben agruparse juntas
 * porque comparten pricing. Aplicamos el mismo orden longest-first que
 * `getPricing()` para no agrupar erróneamente Opus 4.7 con Opus 4.
 */
const FAMILY_KEYS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-opus-4",
] as const;

export function familyKey(model: string): string {
  for (const k of FAMILY_KEYS) {
    if (model.includes(k)) return k;
  }
  return model;
}

/**
 * Devuelve el rango UTC day-aligned para enviar al cost_report:
 * [startOfDay(min(starts)), startOfDay(max(starts)) + 1d].
 */
export function computeReportRange(
  sessionStarts: string[],
): { startingAt: string; endingAt: string } | null {
  const valid = sessionStarts
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n));
  if (valid.length === 0) return null;
  const minMs = Math.min(...valid);
  const maxMs = Math.max(...valid);
  const startDay = new Date(minMs);
  startDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(maxMs);
  endDay.setUTCHours(0, 0, 0, 0);
  endDay.setUTCDate(endDay.getUTCDate() + 1); // exclusive end
  return {
    startingAt: startDay.toISOString().replace(/\.\d{3}Z$/, "Z"),
    endingAt: endDay.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

interface CostComparisonRow {
  model: string;
  estimatedUSD: number;
  realUSD: number;
  divergencePct: number;
  exceedsThreshold: boolean;
}

/**
 * Detecta el escenario "seat-only": el bridge observó coste estimado pero el
 * cost_report de Anthropic está a 0 para todas las filas. Indica que TODO el
 * tráfico fue OAuth/seats — no hay correlato en facturación API. No es drift,
 * es la condición operativa esperada con seats Premium.
 */
export function isSeatOnlyScenario(
  rows: Array<{ estimatedUSD: number; realUSD: number }>,
): boolean {
  if (rows.length === 0) return false;
  const allReal = rows.reduce((acc, r) => acc + r.realUSD, 0);
  const allEst = rows.reduce((acc, r) => acc + r.estimatedUSD, 0);
  return allReal === 0 && allEst > 0;
}

// Factor mínimo real/estimado que indica que el bridge cubre solo una fracción
// del tráfico de la organización. Si real > estimado × este factor, el cost_report
// está incluyendo tráfico de otros devs/workspaces que el bridge no observa.
// Configurado vía COST_PARTIAL_COVERAGE_RATIO; default conservador de 3×.
const _rawCoverageRatio = Number(
  process.env["COST_PARTIAL_COVERAGE_RATIO"] ?? "3",
);
export const COST_PARTIAL_COVERAGE_RATIO =
  Number.isFinite(_rawCoverageRatio) && _rawCoverageRatio > 1
    ? _rawCoverageRatio
    : 3;

/**
 * Detecta el escenario "cobertura parcial": el cost_report (org-wide) es mucho
 * mayor que el coste estimado por el bridge (solo este dev). Sucede cuando el
 * bridge está instalado en una sola máquina pero la organización tiene N devs
 * usando la API key. La divergencia en este caso es estructural — no indica
 * pricing incorrecto sino que la comparación es bridge-vs-org.
 *
 * Ejemplo documentado en Issue #77: bridge estima $255 (1 dev), cost_report
 * reporta $12,085 (38 devs). Divergencia del 97% — ruido esperado hasta que
 * todos los devs tengan el bridge instalado.
 */
export function isPartialCoverageScenario(
  rows: Array<{ estimatedUSD: number; realUSD: number }>,
  ratio: number = COST_PARTIAL_COVERAGE_RATIO,
): boolean {
  if (rows.length === 0) return false;
  const totalReal = rows.reduce((acc, r) => acc + r.realUSD, 0);
  const totalEst = rows.reduce((acc, r) => acc + r.estimatedUSD, 0);
  // Solo aplica cuando ambos lados tienen coste significativo (mix API+seats).
  // Si estimado es 0, es seat-only (otro escenario). Si real es 0, no hay
  // tráfico API que comparar.
  if (totalEst <= 0 || totalReal <= 0) return false;
  return totalReal > totalEst * ratio;
}

export function compareCostByModel(
  estimatedByModel: Map<string, number>,
  realByModel: Map<string, number>,
  threshold: number,
  minCompareUsd: number,
): CostComparisonRow[] {
  const rows: CostComparisonRow[] = [];
  const allKeys = new Set([...estimatedByModel.keys(), ...realByModel.keys()]);
  for (const k of allKeys) {
    const est = estimatedByModel.get(k) ?? 0;
    const real = realByModel.get(k) ?? 0;
    // Filas con poco coste a ambos lados son ruido.
    if (est < minCompareUsd && real < minCompareUsd) continue;
    const baseline = Math.max(est, real);
    const divergencePct = baseline > 0 ? Math.abs(est - real) / baseline : 0;
    rows.push({
      model: k,
      estimatedUSD: Number(est.toFixed(4)),
      realUSD: Number(real.toFixed(4)),
      divergencePct: Number(divergencePct.toFixed(4)),
      exceedsThreshold: divergencePct > threshold,
    });
  }
  return rows;
}

async function reconcileCostAgainstAnthropic(
  estimatedByModel: Map<string, number>,
  range: { startingAt: string; endingAt: string },
): Promise<void> {
  let report;
  try {
    report = await getCostReport({
      startingAt: range.startingAt,
      endingAt: range.endingAt,
      // CRITICAL: without `group_by[]=description`, every result row comes
      // back with `model: null`, sumCostByModel() then puts everything into
      // "__non_token__", and the reconciler filters that out. The result is
      // that the cost-comparison loop runs over an empty map, isSeatOnlyScenario
      // returns false (no rows), and the divergence check is silently bypassed.
      // Discovered via post-v1 validation 2026-05-08.
      groupBy: ["description"],
    });
  } catch (err) {
    emitDegradation("reconcile:cost-report-fetch", err);
    return;
  }
  const realByModelRaw = sumCostByModel(report);
  // Reduce el cost_report al mismo formato familyKey.
  const realByModel = new Map<string, number>();
  for (const [k, v] of realByModelRaw) {
    if (k === "__non_token__") continue; // web_search etc. — no comparable con tokens
    const fk = familyKey(k);
    realByModel.set(fk, (realByModel.get(fk) ?? 0) + v);
  }

  const rows = compareCostByModel(
    estimatedByModel,
    realByModel,
    COST_DIVERGENCE_THRESHOLD,
    COST_COMPARE_MIN_USD,
  );

  log("info", "cost-comparison", {
    range,
    threshold: COST_DIVERGENCE_THRESHOLD,
    rows,
  });

  // Caso especial: todas las filas tienen realUSD=0. Significa que el bridge
  // observó tráfico (estimatedUSD>0) que NO aparece en cost_report — típicamente
  // sesiones de seat Premium (OAuth) que no se facturan vía API. Es información,
  // no anomalía: emitir un único log y suprimir los warnings por modelo (que
  // serían siempre 100% divergencia).
  if (isSeatOnlyScenario(rows)) {
    const totalEst = rows.reduce((acc, r) => acc + r.estimatedUSD, 0);
    log("info", "cost-comparison-seat-only", {
      totalEstimatedUSD: Number(totalEst.toFixed(4)),
      models: rows.map((r) => r.model),
      note: "tráfico estimado sin correlato en cost_report — consistente con seats Premium (no facturados vía API)",
    });
    return;
  }

  // Caso especial: cobertura parcial del bridge. El cost_report (org-wide) es
  // mucho mayor que el estimado local porque el bridge solo está instalado en
  // esta máquina, no en todas. La divergencia es estructural — no indica
  // pricing incorrecto. Emitir info con contexto en lugar de warn ruidoso.
  // Issue #77 — resuelto 2026-05-10.
  if (isPartialCoverageScenario(rows)) {
    const totalEst = rows.reduce((acc, r) => acc + r.estimatedUSD, 0);
    const totalReal = rows.reduce((acc, r) => acc + r.realUSD, 0);
    const bridgeCoverage =
      totalReal > 0 ? Number((totalEst / totalReal).toFixed(4)) : null;
    log("info", "cost-comparison-partial-coverage", {
      totalEstimatedUSD: Number(totalEst.toFixed(4)),
      totalRealUSD: Number(totalReal.toFixed(4)),
      bridgeCoverageFraction: bridgeCoverage,
      partialCoverageRatio: COST_PARTIAL_COVERAGE_RATIO,
      models: rows.map((r) => r.model),
      note: "el cost_report es org-wide; el bridge solo observa las sesiones de esta máquina. Divergencia estructural esperada hasta que todos los devs tengan el bridge instalado.",
    });
    return;
  }

  for (const row of rows) {
    if (row.exceedsThreshold) {
      log("warn", "cost-divergence-detected", {
        model: row.model,
        estimatedUSD: row.estimatedUSD,
        realUSD: row.realUSD,
        divergencePct: row.divergencePct,
        threshold: COST_DIVERGENCE_THRESHOLD,
      });
    }
  }
}

// ─── Replay hook with reconstructed Stop payload ─────────────────────────────

// Safe session ID: only alphanumeric, hyphens, underscores (UUID format).

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
      _invokedByReconciler: true,
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

// ─── S22-B: bridge health trace → Langfuse ──────────────────────────────────

export interface BridgeScanSummary {
  candidates: number;
  drift: number;
  repaired: number;
  failed: number;
  windowHours: number;
  dryRun: boolean;
  degradations: DegradationEntry[];
}

/**
 * Envía un trace `bridge-health` a Langfuse con el resumen del scan y cualquier
 * evento de degradación capturados durante la ejecución del reconciler (S22-B).
 *
 * Usa traceId `bridge-reconciler-YYYY-MM-DD` (day-scoped) para aprovechar
 * el upsert idempotente de Langfuse (I-2). Si el cron corre varias veces al día
 * el trace se actualiza, no se duplica.
 *
 * Es opt-in: solo se ejecuta cuando LANGFUSE_PUBLIC_KEY y LANGFUSE_SECRET_KEY
 * están configuradas (ya verificadas al inicio de main). Errores son no-fatales.
 */
export async function sendBridgeHealthTrace(
  summary: BridgeScanSummary,
  opts: {
    host: string;
    publicKey: string;
    secretKey: string;
  },
): Promise<void> {
  if (!isSafeHost(opts.host)) return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const traceId = `bridge-reconciler-${today}`;
  const now = new Date().toISOString();

  const credentials = Buffer.from(
    `${opts.publicKey}:${opts.secretKey}`,
  ).toString("base64");

  const hasIssues = summary.failed > 0 || summary.degradations.length > 0;
  const status = hasIssues ? "degraded" : "ok";

  const batch = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        timestamp: now,
        name: "bridge-health",
        tags: ["service:bridge", `status:${status}`, `date:${today}`],
        metadata: {
          windowHours: summary.windowHours,
          candidates: summary.candidates,
          drift: summary.drift,
          repaired: summary.repaired,
          failed: summary.failed,
          dryRun: summary.dryRun,
          degradationCount: summary.degradations.length,
          degradations: summary.degradations,
        },
        input: { candidates: summary.candidates, drift: summary.drift },
        output: { repaired: summary.repaired, failed: summary.failed, status },
      },
    },
  ];

  try {
    const host = opts.host.replace(/\/$/, "");
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
      emitDegradation(
        "sendBridgeHealthTrace:http-error",
        new Error(`${res.status}: ${body.slice(0, 200)}`),
      );
    }
  } catch (err) {
    emitDegradation("sendBridgeHealthTrace:fetch", err);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const PK = process.env["LANGFUSE_PUBLIC_KEY"];
  const SK = process.env["LANGFUSE_SECRET_KEY"];
  if (!PK || !SK) {
    log("error", "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
    process.exit(1);
  }

  // S22-B: collector de degradaciones del scan — intercepta emitDegradation para
  // acumular eventos y enviarlos luego como bridge-health trace.
  const collectedDegradations: DegradationEntry[] = [];
  function collectingEmitDegradation(source: string, err: unknown): void {
    const entry: DegradationEntry = {
      type: "degradation",
      source,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    };
    collectedDegradations.push(entry);
    emitDegradation(source, err); // también escribe a stderr como siempre
  }

  const paths = await discoverRecentJsonls(
    WINDOW_HOURS,
    collectingEmitDegradation,
  );
  log("info", "scan-started", {
    windowHours: WINDOW_HOURS,
    candidates: paths.length,
    dryRun: DRY_RUN,
  });

  let drift = 0;
  let repaired = 0;
  let failed = 0;

  // S18-B: acumular coste estimado por modelo + timestamps de inicio para
  // comparar contra Anthropic cost_report al final del scan. Solo se usa si
  // ANTHROPIC_ADMIN_API_KEY está configurada.
  const estimatedByModel = new Map<string, number>();
  const sessionStarts: string[] = [];

  for (const p of paths) {
    const sid = (p.split("/").pop() ?? "").replace(/\.jsonl$/, "");

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

    // S18-B: acumular por familia de modelo y guardar timestamp de inicio.
    if (local.start) sessionStarts.push(local.start);
    for (const [model, agg] of local.models) {
      const fk = familyKey(model);
      estimatedByModel.set(fk, (estimatedByModel.get(fk) ?? 0) + agg.cost);
    }

    const remote = await getTrace(tid);
    const localForDrift = { ...local, end: local.end ?? null };
    let status = classifyDrift(localForDrift, remote);

    // If metadata drift is absent but local cost is non-trivial, check whether
    // Langfuse actually computed costs for the generations. A $0 generation sum
    // while local cost > COST_EPSILON means the SDK did not calculate costs —
    // re-uploading the trace forces recalculation.
    if (status === "OK" && local.totalCost > 0.01) {
      const genCost = await getGenerationCost(tid);
      status = classifyDrift(localForDrift, remote, genCost);
    }

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

  // S18-B/D: comparación post-scan con Anthropic cost_report.
  // Opt-in: solo se ejecuta si ANTHROPIC_ADMIN_API_KEY está set.
  // Errores son no-fatales — el reconciler termina con su exit code habitual.
  if (process.env["ANTHROPIC_ADMIN_API_KEY"] && estimatedByModel.size > 0) {
    const range = computeReportRange(sessionStarts);
    if (range) {
      try {
        await reconcileCostAgainstAnthropic(estimatedByModel, range);
      } catch (err) {
        collectingEmitDegradation("reconcile:cost-comparison", err);
      }
    }
  }

  // S22-B: enviar bridge-health trace con el resumen del scan y degradaciones.
  await sendBridgeHealthTrace(
    {
      candidates: paths.length,
      drift,
      repaired,
      failed,
      windowHours: WINDOW_HOURS,
      dryRun: DRY_RUN,
      degradations: collectedDegradations,
    },
    { host: HOST, publicKey: PK, secretKey: SK },
  );

  process.exit(failed > 0 ? 2 : 0);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    log("error", "unhandled", { error: err.message, stack: err.stack });
    process.exit(2);
  });
}
