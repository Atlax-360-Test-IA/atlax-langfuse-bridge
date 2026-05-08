/**
 * Unit tests for exported wrappers in scripts/reconcile-traces.ts.
 *
 * getTrace() and getGenerationCost() are thin error-isolation wrappers around
 * langfuse-client functions. They must return null (not throw) on any error,
 * and emit a degradation log. These tests cover the catch branches that were
 * previously unreachable in coverage because the wrappers were private.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { saveEnv, restoreEnv } from "./helpers/env";

const ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOkTrace() {
  return {
    id: "cc-abc",
    name: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    userId: null,
    sessionId: "abc",
    tags: [],
    metadata: { turns: 3, estimatedCostUSD: 0.05 },
    input: null,
    output: null,
    observations: [],
    scores: [],
  };
}

// ─── getTrace wrapper ─────────────────────────────────────────────────────────

describe("reconcile-traces: getTrace wrapper", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const SAVED = saveEnv(ENV_KEYS);

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("returns trace on 200", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(makeOkTrace()), { status: 200 }),
      ),
    );
    const { getTrace } = await import("../scripts/reconcile-traces");
    const result = await getTrace("cc-abc");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("cc-abc");
  });

  test("returns null on 404 (trace not yet in Langfuse)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    );
    const { getTrace } = await import("../scripts/reconcile-traces");
    const result = await getTrace("cc-missing");
    expect(result).toBeNull();
  });

  test("returns null (not throws) when fetch rejects — catch branch", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const { getTrace } = await import("../scripts/reconcile-traces");
    const result = await getTrace("cc-network-err");
    expect(result).toBeNull();
  });

  test("returns null (not throws) on 500 error — catch branch", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("internal error", { status: 500 })),
    );
    const { getTrace } = await import("../scripts/reconcile-traces");
    const result = await getTrace("cc-500");
    expect(result).toBeNull();
  });
});

// ─── getGenerationCost wrapper ────────────────────────────────────────────────

describe("reconcile-traces: getGenerationCost wrapper", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const SAVED = saveEnv(ENV_KEYS);

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("returns summed cost on success", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { calculatedTotalCost: 0.04 },
              { calculatedTotalCost: 0.01 },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { getGenerationCost } = await import("../scripts/reconcile-traces");
    const result = await getGenerationCost("cc-abc");
    expect(result).toBeCloseTo(0.05, 6);
  });

  test("returns 0 for empty observations", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
    );
    const { getGenerationCost } = await import("../scripts/reconcile-traces");
    const result = await getGenerationCost("cc-empty");
    expect(result).toBe(0);
  });

  test("returns null (not throws) when fetch rejects — catch branch", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("timeout")));
    const { getGenerationCost } = await import("../scripts/reconcile-traces");
    const result = await getGenerationCost("cc-timeout");
    expect(result).toBeNull();
  });

  test("returns null on non-ok response — catch branch", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("error", { status: 503 })),
    );
    const { getGenerationCost } = await import("../scripts/reconcile-traces");
    const result = await getGenerationCost("cc-503");
    expect(result).toBeNull();
  });
});
