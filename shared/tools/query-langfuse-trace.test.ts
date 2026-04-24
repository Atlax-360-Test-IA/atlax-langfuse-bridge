import { describe, expect, test } from "bun:test";
import { queryLangfuseTrace } from "./query-langfuse-trace";

describe("queryLangfuseTrace.validate", () => {
  test("accepts empty input (all filters optional)", () => {
    const r = queryLangfuseTrace.validate({});
    expect(r.ok).toBe(true);
  });

  test("accepts valid traceId", () => {
    const r = queryLangfuseTrace.validate({ traceId: "cc-abc-123" });
    expect(r.ok).toBe(true);
  });

  test("accepts valid full filter set", () => {
    const r = queryLangfuseTrace.validate({
      userId: "dev@example.com",
      tags: ["project:org/repo", "billing:anthropic-team-standard"],
      fromTimestamp: "2026-04-01T00:00:00Z",
      toTimestamp: "2026-04-24T23:59:59Z",
      limit: 50,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const r = queryLangfuseTrace.validate("not an object");
    expect(r.ok).toBe(false);
  });

  test("rejects non-string traceId", () => {
    const r = queryLangfuseTrace.validate({ traceId: 123 });
    expect(r.ok).toBe(false);
  });

  test("rejects non-array tags", () => {
    const r = queryLangfuseTrace.validate({ tags: "single-tag" });
    expect(r.ok).toBe(false);
  });

  test("rejects tags with non-string elements", () => {
    const r = queryLangfuseTrace.validate({ tags: ["ok", 42] });
    expect(r.ok).toBe(false);
  });

  test("rejects limit > 100", () => {
    const r = queryLangfuseTrace.validate({ limit: 500 });
    expect(r.ok).toBe(false);
  });

  test("rejects limit <= 0", () => {
    const r = queryLangfuseTrace.validate({ limit: 0 });
    expect(r.ok).toBe(false);
  });
});

describe("queryLangfuseTrace metadata", () => {
  test("name matches convention", () => {
    expect(queryLangfuseTrace.name).toBe("query-langfuse-trace");
  });

  test("tier is cached_llm (output is deterministic metadata)", () => {
    expect(queryLangfuseTrace.tier).toBe("cached_llm");
  });

  test("allowedAgentTypes includes coordinator and trace-analyst", () => {
    expect(queryLangfuseTrace.allowedAgentTypes).toContain("coordinator");
    expect(queryLangfuseTrace.allowedAgentTypes).toContain("trace-analyst");
  });
});
