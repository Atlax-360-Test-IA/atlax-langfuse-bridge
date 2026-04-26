/**
 * Tests for queryLangfuseTrace.execute() — covers the network paths and
 * cache hit/miss logic that are not tested in the validate-only suite.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { clearCache } from "../hash-cache";
import { queryLangfuseTrace } from "./query-langfuse-trace";
import type { ToolContext } from "./types";

const CTX: ToolContext = { agentType: "coordinator", stepBudgetMs: 10_000 };

const TRACE_FIXTURE = {
  id: "cc-abc-123",
  name: "claude-code-session",
  timestamp: "2026-04-15T10:00:00.000Z",
  userId: "dev@example.com",
  sessionId: "abc-123",
  tags: ["project:org/repo"],
  metadata: { turns: 3, estimatedCostUSD: 0.05 },
  input: {},
  output: {},
  observations: [],
  scores: [],
};

const LIST_FIXTURE = {
  data: [TRACE_FIXTURE],
  meta: { totalItems: 1 },
};

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("queryLangfuseTrace.execute — traceId lookup", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearCache();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("returns single trace on direct traceId lookup", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const out = await queryLangfuseTrace.execute(
      { traceId: "cc-abc-123" },
      CTX,
    );
    expect(out.traces).toHaveLength(1);
    expect(out.traces[0]!.id).toBe("cc-abc-123");
    expect(out.fromCache).toBe(false);
  });

  test("returns empty array when trace not found (404)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const out = await queryLangfuseTrace.execute(
      { traceId: "cc-missing" },
      CTX,
    );
    expect(out.traces).toHaveLength(0);
    expect(out.fromCache).toBe(false);
  });

  test("maps estimatedCostUSD from metadata", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const out = await queryLangfuseTrace.execute(
      { traceId: "cc-abc-123" },
      CTX,
    );
    expect(out.traces[0]!.estimatedCostUSD).toBe(0.05);
  });

  test("maps turns from metadata", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const out = await queryLangfuseTrace.execute(
      { traceId: "cc-abc-123" },
      CTX,
    );
    expect(out.traces[0]!.turns).toBe(3);
  });

  test("returns null for missing numeric metadata fields", async () => {
    const trace = { ...TRACE_FIXTURE, metadata: {} };
    fetchSpy.mockResolvedValueOnce(makeResponse(trace));
    const out = await queryLangfuseTrace.execute(
      { traceId: "cc-abc-123" },
      CTX,
    );
    expect(out.traces[0]!.estimatedCostUSD).toBeNull();
    expect(out.traces[0]!.turns).toBeNull();
  });
});

describe("queryLangfuseTrace.execute — cache hit/miss", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearCache();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("second identical call hits cache (fromCache=true)", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const input = { traceId: "cc-cache-test" };
    await queryLangfuseTrace.execute(input, CTX);
    const second = await queryLangfuseTrace.execute(input, CTX);
    expect(second.fromCache).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("different inputs produce different cache keys (no cross-contamination)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(TRACE_FIXTURE)),
    );
    await queryLangfuseTrace.execute({ traceId: "cc-a" }, CTX);
    const b = await queryLangfuseTrace.execute({ traceId: "cc-b" }, CTX);
    expect(b.fromCache).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("cached result preserves trace data correctly", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(TRACE_FIXTURE));
    const input = { traceId: "cc-abc-123" };
    await queryLangfuseTrace.execute(input, CTX);
    const cached = await queryLangfuseTrace.execute(input, CTX);
    expect(cached.traces[0]!.id).toBe("cc-abc-123");
    expect(cached.traces[0]!.userId).toBe("dev@example.com");
  });
});

describe("queryLangfuseTrace.execute — list (no traceId)", () => {
  const origEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearCache();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test("uses listTraces when no traceId provided", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(LIST_FIXTURE));
    const out = await queryLangfuseTrace.execute(
      { tags: ["project:org/repo"], limit: 10 },
      CTX,
    );
    expect(out.traces).toHaveLength(1);
    expect(out.fromCache).toBe(false);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/api/public/traces");
    expect(url).not.toContain("/api/public/traces/");
  });

  test("empty filter set uses listTraces with defaults", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ data: [], meta: { totalItems: 0 } }),
    );
    const out = await queryLangfuseTrace.execute({}, CTX);
    expect(out.traces).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("tag list sorts for stable cache key", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(LIST_FIXTURE)),
    );
    // Same tags in different order → same cache key → second call hits cache
    await queryLangfuseTrace.execute({ tags: ["b:2", "a:1"] }, CTX);
    const second = await queryLangfuseTrace.execute(
      { tags: ["a:1", "b:2"] },
      CTX,
    );
    expect(second.fromCache).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
