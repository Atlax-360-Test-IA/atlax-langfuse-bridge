#!/usr/bin/env bun
/**
 * smoke-litellm-pro-e2e.ts — Smoke E2E del gateway LiteLLM en Cloud Run PRO.
 *
 * Verifica que el gateway desplegado en https://litellm.atlax360.ai funciona
 * extremo a extremo con virtual keys y propaga trazas a Langfuse PRO.
 *
 * Cuatro checks (todos requeridos):
 *   1. GET /health/liveliness → 200
 *   2. POST /v1/chat/completions con virtual key (orvian-prod) → choice válida
 *   3. Una traza con name=litellm-* aparece en Langfuse PRO post-callTime
 *   4. La traza tiene name=litellm-acompletion (shape canónico del callback)
 *
 * Skip-graceful: si falta LITELLM_PRO_BASE_URL, ORVIAN_PROD_KEY, LANGFUSE_PRO_PK
 * o LANGFUSE_PRO_SK, exit 0 (no rompe CI sin credenciales).
 *
 * Variables (lee de ~/.atlax-ai/reconcile.env si no están set):
 *   LITELLM_PRO_BASE_URL  — default: https://litellm.atlax360.ai
 *   LANGFUSE_PRO_BASE_URL — default: https://langfuse.atlax360.ai
 *   ORVIAN_PROD_KEY       — virtual key (sk-...)
 *   LANGFUSE_PRO_PK       — public key del proyecto Langfuse PRO
 *   LANGFUSE_PRO_SK       — secret key del proyecto Langfuse PRO
 *
 * Usage:
 *   bun run scripts/smoke-litellm-pro-e2e.ts
 */

import { loadEnvFile } from "../shared/env-loader";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  loadEnvFile();

  const litellmBase = (
    process.env["LITELLM_PRO_BASE_URL"] ?? "https://litellm.atlax360.ai"
  ).replace(/\/$/, "");
  const langfuseBase = (
    process.env["LANGFUSE_PRO_BASE_URL"] ?? "https://langfuse.atlax360.ai"
  ).replace(/\/$/, "");

  const orvianKey = process.env["ORVIAN_PROD_KEY"];
  const pk = process.env["LANGFUSE_PRO_PK"];
  const sk = process.env["LANGFUSE_PRO_SK"];

  if (!orvianKey) {
    process.stderr.write("[smoke-pro] ORVIAN_PROD_KEY no configurada — SKIP\n");
    process.exit(0);
  }
  if (!pk || !sk) {
    process.stderr.write(
      "[smoke-pro] LANGFUSE_PRO_PK / LANGFUSE_PRO_SK no configuradas — SKIP\n",
    );
    process.exit(0);
  }

  const results: CheckResult[] = [];
  const callTime = new Date();

  // ── Check 1: health/liveliness ────────────────────────────────────────────
  process.stderr.write(
    `[smoke-pro] [1/4] GET ${litellmBase}/health/liveliness\n`,
  );
  try {
    const res = await fetch(`${litellmBase}/health/liveliness`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      results.push({
        name: "health-liveliness",
        ok: false,
        detail: `HTTP ${res.status}`,
      });
    } else {
      results.push({
        name: "health-liveliness",
        ok: true,
        detail: `HTTP ${res.status}`,
      });
    }
  } catch (err) {
    results.push({
      name: "health-liveliness",
      ok: false,
      detail: (err as Error).message,
    });
  }

  // ── Check 2: chat completion con virtual key ──────────────────────────────
  process.stderr.write(
    `[smoke-pro] [2/4] POST ${litellmBase}/v1/chat/completions (orvian-prod)\n`,
  );
  let completionId: string | null = null;
  try {
    const res = await fetch(`${litellmBase}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${orvianKey}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Responde con exactamente: OK" }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text();
      results.push({
        name: "chat-completion",
        ok: false,
        detail: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      });
    } else {
      const data = (await res.json()) as {
        id: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        results.push({
          name: "chat-completion",
          ok: false,
          detail: "respuesta sin choices[0].message.content",
        });
      } else {
        completionId = data.id;
        results.push({
          name: "chat-completion",
          ok: true,
          detail: `id=${data.id} content=${JSON.stringify(content)}`,
        });
      }
    }
  } catch (err) {
    results.push({
      name: "chat-completion",
      ok: false,
      detail: (err as Error).message,
    });
  }

  // Si los dos primeros checks fallan, no tiene sentido seguir
  if (!results.every((r) => r.ok)) {
    printResults(results);
    process.exit(1);
  }

  // ── Checks 3+4: traza en Langfuse PRO ────────────────────────────────────
  // NOTA: LiteLLM v1.83.7 tiene un bug conocido (ver tests/litellm-m2-callback.test.ts)
  // por el que `langfuse_default_tags` del config.yaml no se aplican siempre.
  // Por eso buscamos por `name=litellm-acompletion` + ventana temporal, no
  // por filtro de tag.
  process.stderr.write(
    `[smoke-pro] [3-4/4] Polling ${langfuseBase} for litellm-acompletion trace...\n`,
  );

  const auth = "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64");
  const maxWaitMs = 60_000;
  const deadline = Date.now() + maxWaitMs;
  let delayMs = 2_000;
  let traceFound: {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
  } | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delayMs));

    try {
      // Listar las trazas más recientes y filtrar en memoria por name + tiempo.
      const url = `${langfuseBase}/api/public/traces?limit=20`;
      const res = await fetch(url, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        delayMs = Math.min(delayMs * 2, 10_000);
        continue;
      }
      const data = (await res.json()) as {
        data: Array<{
          id: string;
          name?: string;
          timestamp: string;
          metadata?: Record<string, unknown>;
        }>;
      };
      for (const trace of data.data ?? []) {
        const traceTime = new Date(trace.timestamp);
        const isLitellm = (trace.name ?? "").includes("litellm");
        if (isLitellm && traceTime >= callTime) {
          traceFound = {
            id: trace.id,
            name: trace.name ?? "",
            metadata: trace.metadata ?? {},
          };
          break;
        }
      }
    } catch {
      // sigue polling — la traza puede tardar 10-15s en ser procesada
    }
    if (traceFound) break;
    delayMs = Math.min(delayMs * 2, 10_000);
  }

  if (!traceFound) {
    results.push({
      name: "trace-in-langfuse",
      ok: false,
      detail: `no aparece traza tras ${maxWaitMs / 1000}s`,
    });
    results.push({
      name: "trace-callback-shape",
      ok: false,
      detail: "no aplicable (sin traza)",
    });
  } else {
    results.push({
      name: "trace-in-langfuse",
      ok: true,
      detail: `id=${traceFound.id} name=${traceFound.name} (completion=${completionId ?? "?"})`,
    });
    // El callback Langfuse de LiteLLM debe producir trace.name = "litellm-acompletion".
    // Si cambia el nombre, el dashboard de FinOps deja de matchear.
    if (traceFound.name === "litellm-acompletion") {
      results.push({
        name: "trace-callback-shape",
        ok: true,
        detail: "name=litellm-acompletion (callback canónico)",
      });
    } else {
      results.push({
        name: "trace-callback-shape",
        ok: false,
        detail: `name=${traceFound.name} (esperado: litellm-acompletion)`,
      });
    }
  }

  printResults(results);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function printResults(results: CheckResult[]): void {
  process.stderr.write("\n=== Smoke LiteLLM PRO E2E ===\n");
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    process.stderr.write(`  ${mark} ${r.name} — ${r.detail}\n`);
  }
  const passed = results.filter((r) => r.ok).length;
  process.stderr.write(`\n${passed}/${results.length} checks passed\n`);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    process.stderr.write(`[smoke-pro] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
