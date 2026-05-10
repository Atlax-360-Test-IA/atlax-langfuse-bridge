/**
 * tests/litellm-m3-virtual-keys.test.ts — S20-A / S20-B / S20-C
 *
 * Smoke tests for LiteLLM M3: virtual keys per-workload + budget enforcement.
 *
 * S20-A: /key/generate operativo — crea una virtual key con budget y verifica shape.
 * S20-B: Budget enforcement — superado el max_budget, el proxy devuelve 400
 *         con type="budget_exceeded" (LiteLLM v1.83.7 usa 400, no 429).
 * S20-C: Atribución en Langfuse — user_api_key_alias llega en metadata de la
 *         generation; user_api_key_user_id propaga el user_id de la key (v1.83.10+).
 *
 * Skip graceful si LITELLM_MASTER_KEY o LANGFUSE_PUBLIC_KEY no están configuradas,
 * o si el gateway no es alcanzable.
 *
 * Activar: LITELLM_MASTER_KEY=sk-... LANGFUSE_PUBLIC_KEY=pk-lf-... bun test tests/litellm-m3-virtual-keys.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";

const LITELLM_BASE_URL =
  process.env["LITELLM_BASE_URL"] ?? "http://localhost:4001";
const LITELLM_MASTER_KEY = process.env["LITELLM_MASTER_KEY"] ?? "";
const LANGFUSE_BASE_URL =
  process.env["LANGFUSE_HOST"] ?? "http://localhost:3000";
const LANGFUSE_PK = process.env["LANGFUSE_PUBLIC_KEY"] ?? "";
const LANGFUSE_SK = process.env["LANGFUSE_SECRET_KEY"] ?? "";

const SKIP_REASON_CREDS = "LITELLM_MASTER_KEY no configurada";
const SKIP_REASON_LANGFUSE = "credenciales Langfuse no configuradas";
const KEY_ALIAS_BUDGET = "s20-test-budget-enforcement";
const KEY_ALIAS_ATTR = "s20-test-attribution";

let budgetKey = ""; // sk-... para S20-B
let attrKey = ""; // sk-... para S20-C
let reachable = false;
let langfuseAuth = "";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!LITELLM_MASTER_KEY) return;

  // Verificar que el gateway está activo
  try {
    const r = await fetch(`${LITELLM_BASE_URL}/health`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
      signal: AbortSignal.timeout(3_000),
    });
    reachable = r.ok || r.status === 200;
  } catch {
    reachable = false;
    return;
  }

  if (!reachable) return;

  langfuseAuth = Buffer.from(`${LANGFUSE_PK}:${LANGFUSE_SK}`).toString(
    "base64",
  );

  // Limpiar keys anteriores si existen, luego recrear
  for (const alias of [KEY_ALIAS_BUDGET, KEY_ALIAS_ATTR]) {
    const listRes = await fetch(
      `${LITELLM_BASE_URL}/key/list?key_alias=${encodeURIComponent(alias)}`,
      {
        headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (listRes.ok) {
      const list = (await listRes.json()) as { keys?: string[] };
      if (list.keys && list.keys.length > 0) {
        await fetch(`${LITELLM_BASE_URL}/key/delete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: list.keys }),
          signal: AbortSignal.timeout(5_000),
        });
      }
    }
  }

  // Crear key para S20-B (budget enforcement): max_budget muy bajo
  const budgetRes = await fetch(`${LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key_alias: KEY_ALIAS_BUDGET,
      max_budget: 0.000001, // ~$0.000001 — se agota en la primera llamada
      budget_duration: "1d",
      user_id: "test-user-s20b",
      metadata: { sprint: "S20-B", purpose: "budget-enforcement-test" },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (budgetRes.ok) {
    const body = (await budgetRes.json()) as { key?: string };
    budgetKey = body.key ?? "";
  }

  // Crear key para S20-C (atribución Langfuse)
  const attrRes = await fetch(`${LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key_alias: KEY_ALIAS_ATTR,
      max_budget: 0.01,
      budget_duration: "1d",
      user_id: "test-user-s20c",
      metadata: { sprint: "S20-C", purpose: "langfuse-attribution-test" },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (attrRes.ok) {
    const body = (await attrRes.json()) as { key?: string };
    attrKey = body.key ?? "";
  }
});

afterAll(async () => {
  if (!LITELLM_MASTER_KEY || !reachable) return;
  // Cleanup: eliminar las keys de test
  for (const alias of [KEY_ALIAS_BUDGET, KEY_ALIAS_ATTR]) {
    const listRes = await fetch(
      `${LITELLM_BASE_URL}/key/list?key_alias=${encodeURIComponent(alias)}`,
      {
        headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
        signal: AbortSignal.timeout(5_000),
      },
    ).catch(() => null);
    if (!listRes?.ok) continue;
    const list = (await listRes.json()) as { keys?: string[] };
    if (list.keys && list.keys.length > 0) {
      await fetch(`${LITELLM_BASE_URL}/key/delete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keys: list.keys }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
    }
  }
});

// ─── S20-A: /key/generate operativo ─────────────────────────────────────────

describe("S20-A · /key/generate operativo", () => {
  test("crea virtual key con shape correcto", async () => {
    if (!LITELLM_MASTER_KEY) return void expect(true).toBe(true); // skip
    if (!reachable) return void expect(true).toBe(true);

    const res = await fetch(`${LITELLM_BASE_URL}/key/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key_alias: "s20-shape-check-" + Date.now(),
        max_budget: 0.01,
        budget_duration: "1d",
        user_id: "test-shape-check",
      }),
      signal: AbortSignal.timeout(5_000),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["key"]).toBe("string");
    expect((body["key"] as string).startsWith("sk-")).toBe(true);
    expect(typeof body["key_alias"]).toBe("string");
    expect(typeof body["max_budget"]).toBe("number");
    expect(typeof body["token"]).toBe("string"); // hash SHA256

    // Cleanup
    const listRes = await fetch(
      `${LITELLM_BASE_URL}/key/list?key_alias=${encodeURIComponent(body["key_alias"] as string)}`,
      {
        headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (listRes.ok) {
      const list = (await listRes.json()) as { keys?: string[] };
      if (list.keys?.length) {
        await fetch(`${LITELLM_BASE_URL}/key/delete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: list.keys }),
          signal: AbortSignal.timeout(5_000),
        });
      }
    }
  });

  test("key_alias duplicado devuelve error 400", async () => {
    if (!LITELLM_MASTER_KEY) return void expect(true).toBe(true);
    if (!reachable || !budgetKey) return void expect(true).toBe(true);

    const res = await fetch(`${LITELLM_BASE_URL}/key/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key_alias: KEY_ALIAS_BUDGET, max_budget: 0.01 }),
      signal: AbortSignal.timeout(5_000),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("bad_request_error");
  });
});

// ─── S20-B: budget enforcement ───────────────────────────────────────────────

describe("S20-B · budget enforcement → 400 budget_exceeded", () => {
  test("primera llamada con key de budget mínimo tiene éxito (200)", async () => {
    if (!LITELLM_MASTER_KEY) return void expect(true).toBe(true);
    if (!reachable || !budgetKey) return void expect(true).toBe(true);

    const res = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${budgetKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 3,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    // Primera llamada puede pasar (enforcement asíncrono)
    expect([200, 400]).toContain(res.status);
  });

  test("segunda llamada devuelve 400 con type=budget_exceeded", async () => {
    if (!LITELLM_MASTER_KEY) return void expect(true).toBe(true);
    if (!reachable || !budgetKey) return void expect(true).toBe(true);

    // LiteLLM applies budget enforcement asynchronously after the first call.
    // Poll with exponential backoff (250ms, 500ms, 1s, 2s, 4s — capped at 8s
    // total) until we get a 400 budget_exceeded, instead of a flaky fixed sleep.
    let res!: Response;
    let lastStatus = 0;
    let delayMs = 250;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      res = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${budgetKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4-5-20251001",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 3,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = res.status;
      if (res.status === 400) break;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 4_000);
    }

    expect(lastStatus).toBe(400);
    const body = (await res.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(body.error?.type).toBe("budget_exceeded");
    expect(body.error?.message).toContain("Budget has been exceeded");
  });
});

// ─── S20-C: atribución en Langfuse ──────────────────────────────────────────

// S20-C timeout: llamada real + 4s delay async + fetch Langfuse > 5s default
const S20C_TIMEOUT_MS = 30_000;

async function runS20CAttribution() {
  if (!LITELLM_MASTER_KEY) return void expect(true).toBe(true);
  if (!LANGFUSE_PK || !LANGFUSE_SK) return void expect(true).toBe(true);
  if (!reachable || !attrKey) return void expect(true).toBe(true);

  const fromTs = new Date().toISOString();

  const callRes = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${attrKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "s20c-attribution-probe" }],
      max_tokens: 3,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(callRes.status).toBe(200);

  // Polling hasta que el trace aparezca en Langfuse (callback async puede tardar ~3-12s)
  let traceId = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const r = await fetch(
      `${LANGFUSE_BASE_URL}/api/public/traces?limit=5&fromTimestamp=${encodeURIComponent(fromTs)}&name=litellm-acompletion`,
      {
        headers: { Authorization: `Basic ${langfuseAuth}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!r.ok) continue;
    const body = (await r.json()) as { data: Array<{ id: string }> };
    if (body.data.length > 0) {
      traceId = body.data[0]!.id;
      break;
    }
  }
  expect(traceId).not.toBe("");

  const obsRes = await fetch(
    `${LANGFUSE_BASE_URL}/api/public/observations?traceId=${traceId}&limit=5`,
    {
      headers: { Authorization: `Basic ${langfuseAuth}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  expect(obsRes.status).toBe(200);
  const obsBody = (await obsRes.json()) as {
    data: Array<{
      metadata?: {
        user_api_key_alias?: string | null;
        user_api_key_user_id?: string | null;
      };
    }>;
  };
  expect(obsBody.data.length).toBeGreaterThan(0);

  const meta = obsBody.data[0]!.metadata ?? {};
  expect(meta.user_api_key_alias).toBe(KEY_ALIAS_ATTR);
  // v1.83.10+: user_api_key_user_id propaga el user_id configurado en la key (string no nulo)
  expect(typeof meta.user_api_key_user_id).toBe("string");
}

describe("S20-C · atribución de cost en Langfuse via virtual key", () => {
  test(
    "user_api_key_alias llega en metadata de la generation",
    runS20CAttribution,
    S20C_TIMEOUT_MS,
  );
});
