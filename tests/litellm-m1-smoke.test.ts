/**
 * S17-B smoke test — LiteLLM M1 gateway operativo.
 *
 * Verifica que el gateway LiteLLM arrancado con --profile litellm:
 *   1. Responde 200 en /health/liveliness
 *   2. Acepta requests con master key en /v1/chat/completions (o devuelve 401
 *      si LITELLM_MASTER_KEY no está configurada — gate de autenticación)
 *
 * Skip automático si:
 *   - SKIP_LITELLM_SMOKE=1 (CI sin stack)
 *   - Gateway no accesible en LITELLM_HOST (stack no levantado)
 *
 * No requiere ANTHROPIC_API_KEY real: usa model "claude-sonnet-4-6" que en
 * modo M1 retorna error de upstream si no hay key, pero el gateway DEBE
 * autenticar y rutear antes de llegar a Anthropic — por lo que un 401 del
 * gateway indica falla de auth (master key errónea), no de Anthropic.
 */

import { describe, test, expect, beforeAll } from "bun:test";

const LITELLM_HOST = (
  process.env["LITELLM_HOST"] ?? "http://localhost:4001"
).replace(/\/$/, "");

const LITELLM_MASTER_KEY = process.env["LITELLM_MASTER_KEY"] ?? "";

const SKIP =
  process.env["SKIP_LITELLM_SMOKE"] === "1" ||
  process.env["SKIP_INTEGRATION_TESTS"] === "1";

let gatewayReachable = false;

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
});

describe("LiteLLM M1 smoke — gateway operativo", () => {
  test("/health/liveliness responde 200", async () => {
    if (SKIP) {
      console.log("[skip] SKIP_LITELLM_SMOKE=1");
      return;
    }
    if (!gatewayReachable) {
      console.log(
        `[skip] LiteLLM gateway no accesible en ${LITELLM_HOST} — opt-in profile no levantado (esperado en CI sin stack)`,
      );
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/health/liveliness`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alive");
  });

  test("/health/readiness responde 200", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] stack no accesible");
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/health/readiness`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
  });

  test("/v1/models lista claude-sonnet-4-6 con master key", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] stack no accesible");
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
    expect(ids).toContain("claude-sonnet-4-6");
  });

  test("/v1/models retorna 401 sin autenticación", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] stack no accesible");
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/v1/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    // Sin Authorization header el gateway debe rechazar con 401
    expect(res.status).toBe(401);
  });

  test("/v1/chat/completions con master key no retorna 401 ni 403", async () => {
    if (SKIP || !gatewayReachable) {
      console.log("[skip] stack no accesible");
      return;
    }
    if (!LITELLM_MASTER_KEY) {
      console.log("[skip] LITELLM_MASTER_KEY no configurada");
      return;
    }
    const res = await fetch(`${LITELLM_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // 401/403 = falla de autenticación/autorización en el gateway (bug M1)
    // 200 = llamada real a Anthropic (ANTHROPIC_API_KEY configurada)
    // 402/429/500/502 = gateway autentica correctamente pero upstream falla (aceptable)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
