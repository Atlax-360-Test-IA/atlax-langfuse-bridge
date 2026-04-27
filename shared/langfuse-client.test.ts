/**
 * Tests for shared/langfuse-client.ts
 * Mocks fetch at the module level to avoid hitting a real Langfuse instance.
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import type { LangfuseTrace, ScoreBody } from "./langfuse-client";

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, text = "error"): Response {
  return new Response(text, { status });
}

const TRACE_FIXTURE: LangfuseTrace = {
  id: "cc-abc-123",
  name: "claude-code-session",
  timestamp: "2026-04-15T10:00:00.000Z",
  userId: "dev@example.com",
  sessionId: "abc-123",
  tags: ["project:org/repo", "billing:anthropic-team-standard"],
  metadata: { turns: 3, estimatedCostUSD: 0.05 },
  input: { turns: 3 },
  output: { estimatedCostUSD: 0.05 },
  observations: [],
  scores: [],
};

// ─── buildConfig (via exported functions that call it) ────────────────────────

describe("buildConfig — missing credentials", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("throws when LANGFUSE_PUBLIC_KEY is missing", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    delete process.env["LANGFUSE_SECRET_KEY"];
    const { getTrace } = await import("./langfuse-client");
    await expect(getTrace("any-id")).rejects.toThrow("LANGFUSE_PUBLIC_KEY");
  });

  test("throws when only SECRET_KEY is set", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    process.env["LANGFUSE_SECRET_KEY"] = "sk-secret";
    const { getTrace } = await import("./langfuse-client");
    await expect(getTrace("any-id")).rejects.toThrow("LANGFUSE_PUBLIC_KEY");
  });
});

// ─── getTrace ─────────────────────────────────────────────────────────────────

describe("getTrace", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("returns trace on 200", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const { getTrace } = await import("./langfuse-client");
    const result = await getTrace("cc-abc-123");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("cc-abc-123");
    expect(result!.userId).toBe("dev@example.com");
  });

  test("returns null on 404", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, "not found"));
    const { getTrace } = await import("./langfuse-client");
    const result = await getTrace("cc-missing");
    expect(result).toBeNull();
  });

  test("throws on 500", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, "internal error"));
    const { getTrace } = await import("./langfuse-client");
    await expect(getTrace("cc-err")).rejects.toThrow("500");
  });

  test("calls correct URL with ID encoded", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const { getTrace } = await import("./langfuse-client");
    await getTrace("cc-abc-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/api/public/traces/cc-abc-123");
  });

  test("sends Basic auth header", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const { getTrace } = await import("./langfuse-client");
    await getTrace("cc-abc-123");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toStartWith("Basic ");
    const decoded = atob(headers["Authorization"]!.slice(6));
    expect(decoded).toBe("pk-test:sk-test");
  });

  test("uses override config when provided", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const { getTrace } = await import("./langfuse-client");
    await getTrace("cc-abc-123", {
      host: "https://custom-langfuse.example.com",
      publicKey: "pk-override",
      secretKey: "sk-override",
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toStartWith("https://custom-langfuse.example.com");
  });
});

// ─── listTraces ───────────────────────────────────────────────────────────────

describe("listTraces", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("returns data and meta on success", async () => {
    const listPayload = {
      data: [TRACE_FIXTURE],
      meta: { totalItems: 1 },
    };
    fetchSpy.mockResolvedValueOnce(makeResponse(listPayload));
    const { listTraces } = await import("./langfuse-client");
    const result = await listTraces({ limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.meta.totalItems).toBe(1);
  });

  test("builds correct query string for tags filter", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ data: [], meta: { totalItems: 0 } }),
    );
    const { listTraces } = await import("./langfuse-client");
    await listTraces({
      tags: ["project:org/repo", "billing:vertex-gcp"],
      limit: 5,
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("tags=project%3Aorg%2Frepo");
    expect(url).toContain("tags=billing%3Avertex-gcp");
    expect(url).toContain("limit=5");
  });

  test("builds correct query string for userId filter", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ data: [], meta: { totalItems: 0 } }),
    );
    const { listTraces } = await import("./langfuse-client");
    await listTraces({ userId: "dev@example.com" });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("userId=dev%40example.com");
  });

  test("builds correct query string for timestamp range", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ data: [], meta: { totalItems: 0 } }),
    );
    const { listTraces } = await import("./langfuse-client");
    await listTraces({
      fromTimestamp: "2026-04-01T00:00:00Z",
      toTimestamp: "2026-04-30T23:59:59Z",
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("fromTimestamp=");
    expect(url).toContain("toTimestamp=");
  });

  test("throws on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(403, "forbidden"));
    const { listTraces } = await import("./langfuse-client");
    await expect(listTraces({})).rejects.toThrow("403");
  });
});

// ─── createScore ──────────────────────────────────────────────────────────────

describe("createScore", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("returns score id on success", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-xyz-789" }));
    const { createScore } = await import("./langfuse-client");
    const body: ScoreBody = {
      traceId: "cc-abc-123",
      name: "agent:confidence",
      value: 0.95,
      dataType: "NUMERIC",
    };
    const result = await createScore(body);
    expect(result.id).toBe("score-xyz-789");
  });

  test("sends POST to /api/public/scores", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-abc" }));
    const { createScore } = await import("./langfuse-client");
    await createScore({ traceId: "cc-123", name: "agent:x", value: 1 });
    const url = fetchSpy.mock.calls[0]![0] as string;
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(url).toContain("/api/public/scores");
    expect(init.method).toBe("POST");
  });

  test("serializes body correctly", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-abc" }));
    const { createScore } = await import("./langfuse-client");
    const body: ScoreBody = {
      traceId: "cc-123",
      name: "agent:class",
      value: "anomaly",
      dataType: "CATEGORICAL",
      comment: "cost spike detected",
    };
    await createScore(body);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const parsed = JSON.parse(init.body as string);
    expect(parsed.traceId).toBe("cc-123");
    expect(parsed.value).toBe("anomaly");
    expect(parsed.dataType).toBe("CATEGORICAL");
    expect(parsed.comment).toBe("cost spike detected");
  });

  test("throws on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(422, "invalid score"));
    const { createScore } = await import("./langfuse-client");
    await expect(
      createScore({ traceId: "cc-123", name: "x", value: 1 }),
    ).rejects.toThrow("422");
  });
});
