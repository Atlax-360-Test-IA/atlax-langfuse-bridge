/**
 * tests/bridge-health.test.ts — S22-B
 *
 * Tests for sendBridgeHealthTrace() — the reconciler's self-observability
 * mechanism that sends a bridge-health trace to Langfuse at the end of each
 * scan run. Uses a Bun.serve mock server (port 0) to capture the actual HTTP
 * request without hitting a real Langfuse instance.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  sendBridgeHealthTrace,
  type BridgeScanSummary,
} from "../scripts/reconcile-traces";
import type { DegradationEntry } from "../shared/degradation";

// ─── Mock Langfuse server ─────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

let captured: CapturedRequest | null = null;
let serverPort = 0;

const mockServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    return req.json().then((body) => {
      captured = {
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("Authorization"),
        body,
      };
      return new Response(JSON.stringify({ successes: [], errors: [] }), {
        status: 207,
        headers: { "Content-Type": "application/json" },
      });
    });
  },
});

beforeAll(() => {
  serverPort = mockServer.port!;
});

afterAll(() => {
  mockServer.stop(true);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanSummary(
  overrides: Partial<BridgeScanSummary> = {},
): BridgeScanSummary {
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

function opts() {
  return {
    host: `http://127.0.0.1:${serverPort}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sendBridgeHealthTrace", () => {
  test("sends POST to /api/public/ingestion", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary(), opts());

    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.path).toBe("/api/public/ingestion");
  });

  test("Authorization header is Basic base64(pk:sk)", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary(), opts());

    expect(captured!.auth).toStartWith("Basic ");
    const decoded = atob(captured!.auth!.slice(6));
    expect(decoded).toBe("pk-test:sk-test");
  });

  test("batch contains trace-create with name=bridge-health", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary(), opts());

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    expect(Array.isArray(body.batch)).toBe(true);
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    expect(trace).toBeTruthy();
    const tb = (trace as Record<string, unknown>)["body"] as Record<
      string,
      unknown
    >;
    expect(tb["name"]).toBe("bridge-health");
  });

  test("traceId is day-scoped bridge-reconciler-YYYY-MM-DD", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary(), opts());

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tb = trace!["body"] as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    expect(tb["id"]).toBe(`bridge-reconciler-${today}`);
  });

  test("tags include service:bridge and status:ok when no issues", async () => {
    captured = null;
    await sendBridgeHealthTrace(
      cleanSummary({ failed: 0, degradations: [] }),
      opts(),
    );

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags).toContain("service:bridge");
    expect(tags).toContain("status:ok");
  });

  test("status tag is degraded when failed > 0", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary({ failed: 2 }), opts());

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags).toContain("status:degraded");
  });

  test("status tag is degraded when degradations array is non-empty", async () => {
    captured = null;
    const deg: DegradationEntry = {
      type: "degradation",
      source: "test:source",
      error: "something failed",
      ts: new Date().toISOString(),
    };
    await sendBridgeHealthTrace(
      cleanSummary({ failed: 0, degradations: [deg] }),
      opts(),
    );

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags).toContain("status:degraded");
  });

  test("metadata includes scan summary fields", async () => {
    captured = null;
    await sendBridgeHealthTrace(
      cleanSummary({ candidates: 10, drift: 3, repaired: 2, failed: 1 }),
      opts(),
    );

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const meta = (trace!["body"] as Record<string, unknown>)[
      "metadata"
    ] as Record<string, unknown>;
    expect(meta["candidates"]).toBe(10);
    expect(meta["drift"]).toBe(3);
    expect(meta["repaired"]).toBe(2);
    expect(meta["failed"]).toBe(1);
  });

  test("metadata includes degradations array", async () => {
    captured = null;
    const deg: DegradationEntry = {
      type: "degradation",
      source: "getTrace:fetch",
      error: "ECONNREFUSED",
      ts: "2026-05-07T10:00:00.000Z",
    };
    await sendBridgeHealthTrace(cleanSummary({ degradations: [deg] }), opts());

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const meta = (trace!["body"] as Record<string, unknown>)[
      "metadata"
    ] as Record<string, unknown>;
    expect(meta["degradationCount"]).toBe(1);
    expect(Array.isArray(meta["degradations"])).toBe(true);
    const degs = meta["degradations"] as DegradationEntry[];
    expect(degs[0]!.source).toBe("getTrace:fetch");
    expect(degs[0]!.error).toBe("ECONNREFUSED");
  });

  test("does NOT send when host is unsafe (SSRF guard)", async () => {
    captured = null;
    await sendBridgeHealthTrace(cleanSummary(), {
      host: "http://169.254.169.254/latest/meta-data/",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    expect(captured).toBeNull();
  });
});
