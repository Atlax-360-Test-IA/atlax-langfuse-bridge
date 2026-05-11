/**
 * S19-B smoke test — LiteLLM M2 callback Langfuse operativo.
 *
 * Verifica que una request real a través del gateway LiteLLM genera un trace
 * en Langfuse con observation cuyo `calculatedTotalCost > 0` y cuyos campos
 * de schema v3 (`usageDetails`, `costDetails`) están presentes.
 *
 * Flujo:
 *   1. POST /v1/chat/completions → LiteLLM → Anthropic → respuesta
 *   2. Registrar timestamp justo antes del request
 *   3. Polling en /api/public/traces con fromTimestamp para encontrar el trace
 *      (el x-litellm-call-id NO coincide con el traceId de Langfuse en v1.83.7)
 *   4. GET /api/public/observations?traceId → verificar cost > 0 + schema v3
 *
 * Nota sobre tags (bug LiteLLM v1.83.7):
 *   langfuse_default_tags en config.yaml no se aplica — LiteLLM manda headers
 *   HTTP como tags en lugar. Documentado como deuda técnica; la verificación
 *   de tags se omite hasta actualizar a una versión corregida.
 *
 * Skip automático si:
 *   - SKIP_LITELLM_SMOKE=1 (CI sin stack)
 *   - SKIP_INTEGRATION_TESTS=1
 *   - Gateway no alcanzable en LITELLM_HOST
 *   - LITELLM_MASTER_KEY o credenciales Langfuse no configuradas
 *
 * Variables de entorno requeridas (fuera de CI):
 *   LITELLM_HOST         (default: http://localhost:4001)
 *   LITELLM_MASTER_KEY   master key del gateway
 *   LANGFUSE_BASE_URL    URL del stack Langfuse (default: http://localhost:3000)
 *   LANGFUSE_PUBLIC_KEY  public key del proyecto Langfuse
 *   LANGFUSE_SECRET_KEY  secret key del proyecto Langfuse
 */

import { describe, test, expect, beforeAll } from "bun:test";

const LITELLM_HOST = (
  process.env["LITELLM_HOST"] ?? "http://localhost:4001"
).replace(/\/$/, "");

const LANGFUSE_BASE_URL = (
  process.env["LANGFUSE_BASE_URL"] ??
  process.env["LANGFUSE_HOST"] ??
  "http://localhost:3000"
).replace(/\/$/, "");

const LITELLM_MASTER_KEY = process.env["LITELLM_MASTER_KEY"] ?? "";
const LANGFUSE_PUBLIC_KEY = process.env["LANGFUSE_PUBLIC_KEY"] ?? "";
const LANGFUSE_SECRET_KEY = process.env["LANGFUSE_SECRET_KEY"] ?? "";

const SKIP =
  process.env["SKIP_LITELLM_SMOKE"] === "1" ||
  process.env["SKIP_INTEGRATION_TESTS"] === "1";

const LANGFUSE_AUTH = Buffer.from(
  `${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`,
).toString("base64");

/** Espera hasta que la función retorne truthy, con backoff lineal. */
async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  {
    maxAttempts = 10,
    intervalMs = 2_000,
  }: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollUntil: no se obtuvo resultado en ${maxAttempts} intentos`,
  );
}

/**
 * Busca el trace más reciente de LiteLLM en Langfuse posterior a `fromTs`.
 * LiteLLM v1.83.7 no expone el traceId al cliente, así que buscamos por
 * ventana temporal + nombre de trace.
 */
async function findRecentLitellmTrace(fromTs: Date): Promise<{
  id: string;
  name: string;
  tags: string[];
} | null> {
  const qs = new URLSearchParams({
    limit: "10",
    fromTimestamp: fromTs.toISOString(),
    name: "litellm-acompletion",
  });
  const r = await fetch(
    `${LANGFUSE_BASE_URL}/api/public/traces?${qs.toString()}`,
    {
      headers: { Authorization: `Basic ${LANGFUSE_AUTH}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!r.ok) return null;
  const body = (await r.json()) as {
    data: Array<{ id: string; name: string; tags: string[] }>;
  };
  return body.data[0] ?? null;
}

let gatewayReachable = false;
let langfuseReachable = false;

beforeAll(async () => {
  if (SKIP) return;
  try {
    const res = await fetch(`${LITELLM_HOST}/health/liveliness`, {
      signal: AbortSignal.timeout(3_000),
    });
    gatewayReachable = res.ok;
  } catch {
    gatewayReachable = false;
  }
  try {
    const res = await fetch(`${LANGFUSE_BASE_URL}/api/public/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    langfuseReachable = res.ok;
  } catch {
    langfuseReachable = false;
  }
});

describe("LiteLLM M2 — callback Langfuse + observation shape", () => {
  test("los 3 modelos aparecen en /v1/models", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] gateway no accesible o SKIP_LITELLM_SMOKE=1");
      return;
    }
    if (!LITELLM_MASTER_KEY) {
      console.log("[skip] LITELLM_MASTER_KEY no configurada");
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/v1/models`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-7");
  });

  test("chat/completions con haiku-4-5 genera trace en Langfuse con cost > 0", async () => {
    if (SKIP || !gatewayReachable || !langfuseReachable) {
      console.log("[skip] stack(s) no accesible(s)");
      return;
    }
    if (!LITELLM_MASTER_KEY || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
      console.log("[skip] credenciales no configuradas");
      return;
    }

    // Timestamp justo antes del request para acotar la búsqueda en Langfuse
    const beforeRequest = new Date(Date.now() - 1_000);

    // 1. Enviar request mínima con haiku-4-5 (más barato)
    const chatRes = await fetch(`${LITELLM_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "di ok" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as {
      id: string;
      usage?: { total_tokens?: number };
    };

    // Verificar tokens en la respuesta directa de LiteLLM
    expect(chatBody.usage?.total_tokens ?? 0).toBeGreaterThan(0);

    // 2. Polling: buscar el trace de esta request en Langfuse por ventana temporal.
    //    LiteLLM v1.83.7 no expone el traceId Langfuse al cliente — buscamos por
    //    fromTimestamp + name en lugar de por ID exacto.
    const trace = await pollUntil(() => findRecentLitellmTrace(beforeRequest), {
      maxAttempts: 15,
      intervalMs: 2_000,
    });

    expect(trace.id.length).toBeGreaterThan(0);
    expect(trace.name).toBe("litellm-acompletion");

    // 3. Verificar observations con calculatedTotalCost > 0
    type Observation = {
      id: string;
      type: string;
      calculatedTotalCost: number | null;
      usageDetails?: Record<string, number>;
      costDetails?: Record<string, number>;
    };
    type ObsListResponse = { data: Observation[] };

    const obsRes = await fetch(
      `${LANGFUSE_BASE_URL}/api/public/observations?traceId=${trace.id}&limit=10`,
      {
        headers: { Authorization: `Basic ${LANGFUSE_AUTH}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    expect(obsRes.status).toBe(200);
    const obsList = (await obsRes.json()) as ObsListResponse;
    expect(obsList.data.length).toBeGreaterThan(0);

    // DoD S19-B: al menos una observation con coste calculado > 0
    const withCost = obsList.data.filter(
      (o) => (o.calculatedTotalCost ?? 0) > 0,
    );
    expect(withCost.length).toBeGreaterThan(0);

    const obs = withCost[0]!;

    // Schema v3 — usageDetails y costDetails deben estar presentes
    expect(obs.usageDetails).toBeTruthy();
    expect(typeof obs.usageDetails).toBe("object");
    expect(obs.costDetails).toBeTruthy();

    // Tokens de input presentes (campo 'input' en usageDetails de Langfuse v3)
    const inputTokens =
      (obs.usageDetails?.["input"] ?? 0) +
      (obs.usageDetails?.["promptTokens"] ?? 0);
    expect(inputTokens).toBeGreaterThan(0);

    console.log(
      `[S19-B] trace=${trace.id.slice(0, 8)} cost=${obs.calculatedTotalCost} input_tokens=${inputTokens}`,
    );
  }, 60_000);

  test("gateway responde 401 sin Authorization header", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] gateway no accesible");
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "test" }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(401);
  });
});
