/**
 * tests/reconcile-bridge-health.test.ts
 *
 * Unit tests for sendBridgeHealthTrace() in scripts/reconcile-traces.ts.
 * Covers the HTTP success, HTTP error, fetch-reject, and unsafe-host paths
 * that were previously uncovered (lines 420-505 per coverage report).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { saveEnv, restoreEnv } from "./helpers/env";
import type { DegradationEntry } from "../shared/degradation";

const ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
];

const SAVED = saveEnv(ENV_KEYS);

function makeOpts(port: number) {
  return {
    host: `http://127.0.0.1:${port}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
  };
}

function makeSummary(
  overrides: Partial<{
    candidates: number;
    drift: number;
    repaired: number;
    failed: number;
    windowHours: number;
    dryRun: boolean;
    degradations: DegradationEntry[];
  }> = {},
) {
  return {
    candidates: 5,
    drift: 1,
    repaired: 1,
    failed: 0,
    windowHours: 24,
    dryRun: false,
    degradations: [],
    ...overrides,
  };
}

describe("sendBridgeHealthTrace — HTTP success (status ok)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

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

  test("sends POST to /api/public/ingestion with correct body shape", async () => {
    const captured: { url: string; body: unknown }[] = [];
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      captured.push({ url, body: JSON.parse((init?.body as string) ?? "{}") });
      return Promise.resolve(
        new Response(JSON.stringify({ successes: [], errors: [] }), {
          status: 207,
        }),
      );
    });

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(makeSummary(), makeOpts(3000));

    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toContain("/api/public/ingestion");
    const batch = (captured[0]!.body as { batch: unknown[] }).batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBeGreaterThan(0);
    const traceEvent = (batch as Array<Record<string, unknown>>).find(
      (e) => e["type"] === "trace-create",
    );
    expect(traceEvent).toBeDefined();
    const body = traceEvent!["body"] as Record<string, unknown>;
    expect(body["name"]).toBe("bridge-health");
    expect(body["id"] as string).toMatch(
      /^bridge-reconciler-\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("sets status:ok tag when no failures or degradations", async () => {
    const captured: unknown[][] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        batch: unknown[];
      };
      captured.push(body.batch);
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(
      makeSummary({ failed: 0, degradations: [] }),
      makeOpts(3000),
    );

    const batch = captured[0] as Array<Record<string, unknown>>;
    const traceBody = (
      batch.find((e) => e["type"] === "trace-create") as Record<string, unknown>
    )["body"] as Record<string, unknown>;
    expect(traceBody["tags"] as string[]).toContain("status:ok");
  });

  test("sets status:degraded tag when failed > 0", async () => {
    const captured: unknown[][] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        batch: unknown[];
      };
      captured.push(body.batch);
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(makeSummary({ failed: 2 }), makeOpts(3000));

    const batch = captured[0] as Array<Record<string, unknown>>;
    const traceBody = (
      batch.find((e) => e["type"] === "trace-create") as Record<string, unknown>
    )["body"] as Record<string, unknown>;
    expect(traceBody["tags"] as string[]).toContain("status:degraded");
  });

  test("sets status:degraded when degradations array is non-empty", async () => {
    const captured: unknown[][] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        batch: unknown[];
      };
      captured.push(body.batch);
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(
      makeSummary({
        degradations: [
          {
            type: "degradation",
            source: "test",
            error: "oops",
            ts: new Date().toISOString(),
          },
        ],
      }),
      makeOpts(3000),
    );

    const batch = captured[0] as Array<Record<string, unknown>>;
    const traceBody = (
      batch.find((e) => e["type"] === "trace-create") as Record<string, unknown>
    )["body"] as Record<string, unknown>;
    expect(traceBody["tags"] as string[]).toContain("status:degraded");
  });

  test("includes summary metrics in trace metadata", async () => {
    const captured: unknown[][] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        batch: unknown[];
      };
      captured.push(body.batch);
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    const summary = makeSummary({
      candidates: 10,
      drift: 3,
      repaired: 2,
      failed: 1,
      windowHours: 48,
      dryRun: true,
    });
    await sendBridgeHealthTrace(summary, makeOpts(3000));

    const batch = captured[0] as Array<Record<string, unknown>>;
    const traceBody = (
      batch.find((e) => e["type"] === "trace-create") as Record<string, unknown>
    )["body"] as Record<string, unknown>;
    const meta = traceBody["metadata"] as Record<string, unknown>;
    expect(meta["candidates"]).toBe(10);
    expect(meta["drift"]).toBe(3);
    expect(meta["repaired"]).toBe(2);
    expect(meta["failed"]).toBe(1);
    expect(meta["windowHours"]).toBe(48);
    expect(meta["dryRun"]).toBe(true);
  });
});

describe("sendBridgeHealthTrace — HTTP error path (non-ok response)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

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

  test("does not throw on 500 response — emits degradation silently", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("internal server error", { status: 500 })),
    );

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    // Must not throw
    await expect(
      sendBridgeHealthTrace(makeSummary(), makeOpts(3000)),
    ).resolves.toBeUndefined();
  });

  test("does not throw on 401 response", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await expect(
      sendBridgeHealthTrace(makeSummary(), makeOpts(3000)),
    ).resolves.toBeUndefined();
  });
});

describe("sendBridgeHealthTrace — fetch rejection (network error)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

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

  test("does not throw when fetch rejects with ECONNREFUSED", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await expect(
      sendBridgeHealthTrace(makeSummary(), makeOpts(3000)),
    ).resolves.toBeUndefined();
  });

  test("does not throw when fetch rejects with timeout", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      ),
    );

    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await expect(
      sendBridgeHealthTrace(makeSummary(), makeOpts(3000)),
    ).resolves.toBeUndefined();
  });
});

describe("sendBridgeHealthTrace — unsafe host guard", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("does not call fetch for non-https non-localhost host", async () => {
    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(makeSummary(), {
      host: "http://evil.example.com",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("does not call fetch for ftp:// host", async () => {
    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(makeSummary(), {
      host: "ftp://somehost.com",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("calls fetch for https:// host", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    const { sendBridgeHealthTrace } =
      await import("../scripts/reconcile-traces");
    await sendBridgeHealthTrace(makeSummary(), {
      host: "https://langfuse.atlax360.ai",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
