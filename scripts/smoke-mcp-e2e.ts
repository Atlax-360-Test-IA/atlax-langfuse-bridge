#!/usr/bin/env bun
/**
 * smoke-mcp-e2e.ts — Verifica end-to-end que las AgentTools del bridge
 * funcionan contra Langfuse real.
 *
 * Flow:
 *   1. Inyectar un trace sintético via /api/public/ingestion (mismo path
 *      que el hook Stop). Tag identificador único para localizar el trace.
 *   2. query-langfuse-trace por traceId — verifica lookup directo + fromCache=false.
 *   3. query-langfuse-trace mismo input — verifica fromCache=true (cache hit).
 *   4. query-langfuse-trace listado por tag — verifica que el trace aparece.
 *   5. annotate-observation — postear un score NUMERIC y un CATEGORICAL.
 *   6. Round-trip: getTrace directo → verificar que los scores aparecen.
 *
 * Skip claro (exit 0) si faltan credenciales o Langfuse no responde.
 * Exit 1 si las tools fallan algún assert.
 *
 * Variables (lee también de ~/.atlax-ai/reconcile.env si no están set):
 *   LANGFUSE_HOST       (default http://localhost:3000)
 *   LANGFUSE_PUBLIC_KEY
 *   LANGFUSE_SECRET_KEY
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getTrace } from "../shared/langfuse-client";
import { queryLangfuseTrace } from "../shared/tools/query-langfuse-trace";
import { annotateObservation } from "../shared/tools/annotate-observation";
import type { ToolContext } from "../shared/tools/types";

// ─── Env loading (mismo patrón que smoke-litellm-langfuse.ts) ───────────────

function loadEnvFile(): void {
  const envPath = join(homedir(), ".atlax-ai", "reconcile.env");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore — relies on shell env
  }
}

// ─── Pretty logging ─────────────────────────────────────────────────────────

const log = (s: string) => process.stderr.write(`[smoke-mcp] ${s}\n`);
const ok = (s: string) => process.stderr.write(`[smoke-mcp] ✓ ${s}\n`);
const fail = (s: string) => process.stderr.write(`[smoke-mcp] ✗ ${s}\n`);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function injectTrace(
  host: string,
  pk: string,
  sk: string,
  traceId: string,
  tag: string,
): Promise<void> {
  const auth = "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64");
  const now = new Date().toISOString();
  const batch = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        timestamp: now,
        name: "smoke-mcp-e2e",
        userId: "smoke-mcp@atlax360.com",
        tags: [tag, "source:smoke-mcp-e2e"],
        metadata: {
          smoke: true,
          turns: 1,
          estimatedCostUSD: 0.0001,
        },
        input: { test: "input" },
        output: { test: "output" },
      },
    },
  ];
  const res = await fetch(`${host}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ingestion failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

function backoffMs(attempt: number, capMs = 5_000): number {
  const base = Math.min(500 * 2 ** attempt, capMs);
  return base * (0.8 + Math.random() * 0.4); // ±20% jitter
}

async function waitForTrace(
  traceId: string,
  maxWaitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, backoffMs(attempt++)));
    try {
      const t = await getTrace(traceId);
      if (t) return true;
    } catch {
      // keep polling
    }
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  loadEnvFile();

  const host = (process.env.LANGFUSE_HOST ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;

  if (!pk || !sk) {
    log("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — SKIP");
    return 0;
  }

  // Pre-flight: ¿responde Langfuse?
  try {
    const ping = await fetch(`${host}/api/public/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!ping.ok) {
      log(`Langfuse health returned ${ping.status} — SKIP`);
      return 0;
    }
  } catch (err) {
    log(`Langfuse unreachable at ${host} (${(err as Error).message}) — SKIP`);
    return 0;
  }

  const ctx: ToolContext = { agentType: "coordinator", stepBudgetMs: 10_000 };
  const runId = randomUUID().slice(0, 8);
  const traceId = `smoke-mcp-${runId}`;
  const tag = `smoke-mcp-run:${runId}`;
  let failures = 0;

  log(`run id=${runId}, traceId=${traceId}`);

  // ── Step 1: inject ────────────────────────────────────────────────────────
  try {
    await injectTrace(host, pk, sk, traceId, tag);
    ok("trace injected via /api/public/ingestion");
  } catch (err) {
    fail(`inject failed: ${(err as Error).message}`);
    return 1;
  }

  // Worker async ingestion → polling
  const seen = await waitForTrace(traceId, 30_000);
  if (!seen) {
    fail("trace not visible after 30s — Langfuse worker may be down");
    return 1;
  }
  ok("trace visible in Langfuse (post-worker ingestion)");

  // ── Step 2: query-langfuse-trace by traceId ───────────────────────────────
  try {
    const out = await queryLangfuseTrace.execute({ traceId }, ctx);
    if (out.traces.length !== 1) {
      fail(`expected 1 trace, got ${out.traces.length}`);
      failures++;
    } else if (out.traces[0]!.id !== traceId) {
      fail(`unexpected trace id: ${out.traces[0]!.id}`);
      failures++;
    } else if (out.fromCache) {
      fail("first call should NOT be from cache");
      failures++;
    } else {
      ok("query-langfuse-trace lookup OK");
    }
  } catch (err) {
    fail(`query-langfuse-trace threw: ${(err as Error).message}`);
    failures++;
  }

  // ── Step 3: cache hit ─────────────────────────────────────────────────────
  try {
    const out = await queryLangfuseTrace.execute({ traceId }, ctx);
    if (!out.fromCache) {
      fail("second identical call should be from cache");
      failures++;
    } else {
      ok("cache hit confirmed (fromCache=true)");
    }
  } catch (err) {
    fail(`cache hit query threw: ${(err as Error).message}`);
    failures++;
  }

  // ── Step 4: list by tag ───────────────────────────────────────────────────
  try {
    const out = await queryLangfuseTrace.execute(
      { tags: [tag], limit: 10 },
      ctx,
    );
    const found = out.traces.find((t) => t.id === traceId);
    if (!found) {
      fail(`tag listing did not include ${traceId}`);
      failures++;
    } else {
      ok(`list by tag ${tag} returned the trace`);
    }
  } catch (err) {
    fail(`list-by-tag threw: ${(err as Error).message}`);
    failures++;
  }

  // ── Step 5: annotate (NUMERIC + CATEGORICAL) ──────────────────────────────
  try {
    const numeric = await annotateObservation.execute(
      {
        traceId,
        name: "agent:smoke-confidence",
        value: 0.91,
        comment: "smoke E2E numeric score",
      },
      ctx,
    );
    if (!numeric.scoreId) {
      fail("annotate (NUMERIC) returned empty scoreId");
      failures++;
    } else {
      ok(`annotate NUMERIC OK (scoreId=${numeric.scoreId.slice(0, 8)}…)`);
    }

    const categorical = await annotateObservation.execute(
      {
        traceId,
        name: "agent:smoke-class",
        value: "ok",
        dataType: "CATEGORICAL",
      },
      ctx,
    );
    if (!categorical.scoreId) {
      fail("annotate (CATEGORICAL) returned empty scoreId");
      failures++;
    } else {
      ok(
        `annotate CATEGORICAL OK (scoreId=${categorical.scoreId.slice(0, 8)}…)`,
      );
    }
  } catch (err) {
    fail(`annotate threw: ${(err as Error).message}`);
    failures++;
  }

  // ── Step 6: round-trip — scores aparecen en el trace ──────────────────────
  // Polling porque scores también pasan por el worker
  log("waiting for scores to surface in trace (round-trip)...");
  let roundTripOk = false;
  const rtDeadline = Date.now() + 20_000;
  let rtAttempt = 0;
  while (Date.now() < rtDeadline) {
    await new Promise((r) => setTimeout(r, backoffMs(rtAttempt++)));
    try {
      const trace = await getTrace(traceId);
      const scoreNames =
        (trace?.scores as Array<{ name?: string }> | undefined)?.map(
          (s) => s.name ?? "",
        ) ?? [];
      if (
        scoreNames.includes("agent:smoke-confidence") &&
        scoreNames.includes("agent:smoke-class")
      ) {
        roundTripOk = true;
        break;
      }
    } catch {
      // keep polling
    }
  }
  if (roundTripOk) {
    ok("round-trip: both scores visible in trace.scores[]");
  } else {
    fail("round-trip: scores not visible after 20s");
    failures++;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  if (failures === 0) {
    log(`✅ all checks passed (traceId=${traceId})`);
    return 0;
  }
  log(`❌ ${failures} check(s) failed`);
  return 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: Error) => {
      process.stderr.write(`[smoke-mcp] fatal: ${err.message}\n`);
      process.exit(1);
    });
}
