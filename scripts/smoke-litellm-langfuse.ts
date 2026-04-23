#!/usr/bin/env bun
/**
 * smoke-litellm-langfuse.ts — Verifica que el callback Langfuse de LiteLLM
 * funciona end-to-end: envía un chat completion al gateway y comprueba que
 * aparece un trace con tag `source:litellm-gateway` en Langfuse.
 *
 * Requiere el stack corriendo: docker compose --profile litellm up -d
 *
 * Variables de entorno (lee de ~/.atlax-ai/reconcile.env si no están set):
 *   LITELLM_MASTER_KEY   — master key del gateway
 *   LANGFUSE_PUBLIC_KEY   — pk del proyecto Langfuse
 *   LANGFUSE_SECRET_KEY   — sk del proyecto Langfuse
 *   LANGFUSE_HOST         — URL de Langfuse (default: http://localhost:3000)
 *   LITELLM_HOST          — URL del gateway (default: http://localhost:4001)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Load env from reconcile.env if not already set ──────────────────────────

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
    // File not found — rely on env vars
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFile();

  const litellmHost = (
    process.env.LITELLM_HOST ?? "http://localhost:4001"
  ).replace(/\/$/, "");
  const langfuseHost = (
    process.env.LANGFUSE_HOST ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  const masterKey = process.env.LITELLM_MASTER_KEY;
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;

  if (!masterKey) {
    process.stderr.write("[smoke] LITELLM_MASTER_KEY not set\n");
    process.exit(1);
  }
  if (!pk || !sk) {
    process.stderr.write(
      "[smoke] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set\n",
    );
    process.exit(1);
  }

  const auth = "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64");
  const callTime = new Date();

  // ── Step 1: Send a minimal chat completion to LiteLLM ──
  process.stderr.write(
    `[smoke] Sending chat completion to ${litellmHost}...\n`,
  );

  const completionRes = await fetch(`${litellmHost}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterKey}`,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Say hi in exactly one word." }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!completionRes.ok) {
    const body = await completionRes.text();
    process.stderr.write(
      `[smoke] LiteLLM returned ${completionRes.status}: ${body}\n`,
    );
    process.exit(1);
  }

  const completion = (await completionRes.json()) as {
    id: string;
    model: string;
  };
  process.stderr.write(
    `[smoke] Completion OK — id=${completion.id}, model=${completion.model}\n`,
  );

  // ── Step 2: Poll Langfuse for a trace with source:litellm-gateway ──
  const maxWaitMs = 30_000;
  const pollIntervalMs = 3_000;
  const deadline = Date.now() + maxWaitMs;

  process.stderr.write(
    `[smoke] Polling Langfuse for trace (max ${maxWaitMs / 1000}s)...\n`,
  );

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    try {
      const url = `${langfuseHost}/api/public/traces?tags=source:litellm-gateway&limit=5&orderBy=timestamp.desc`;
      const res = await fetch(url, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        process.stderr.write(`[smoke] Langfuse API returned ${res.status}\n`);
        continue;
      }

      const data = (await res.json()) as {
        data: Array<{ id: string; timestamp: string }>;
      };

      for (const trace of data.data ?? []) {
        const traceTime = new Date(trace.timestamp);
        if (traceTime >= callTime) {
          process.stderr.write(
            `[smoke] ✓ Trace found: ${trace.id} (${trace.timestamp})\n`,
          );
          process.exit(0);
        }
      }
    } catch (err) {
      process.stderr.write(`[smoke] Poll error: ${(err as Error).message}\n`);
    }
  }

  process.stderr.write("[smoke] ✗ No trace found within timeout. Check:\n");
  process.stderr.write(
    "  1. LANGFUSE_INIT_PROJECT_*_KEY are not 'PENDIENTE'\n",
  );
  process.stderr.write("  2. langfuse-web is healthy: docker compose ps\n");
  process.stderr.write(
    "  3. LiteLLM logs: docker compose logs litellm | grep -i langfuse\n",
  );
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    process.stderr.write(`[smoke] Error: ${err.message}\n`);
    process.exit(1);
  });
}
