import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { annotateObservation } from "./annotate-observation";
import type { ToolContext } from "./types";

const CTX: ToolContext = { agentType: "coordinator", stepBudgetMs: 10_000 };

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("annotateObservation.validate", () => {
  test("accepts minimal valid input (numeric)", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:confidence",
      value: 0.85,
    });
    expect(r.ok).toBe(true);
  });

  test("accepts categorical value", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:anomaly-class",
      value: "cost-spike",
      dataType: "CATEGORICAL",
    });
    expect(r.ok).toBe(true);
  });

  test("accepts boolean value", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:needs-review",
      value: true,
    });
    expect(r.ok).toBe(true);
  });

  test("accepts observationId + comment", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      observationId: "obs-456",
      name: "agent:token-efficiency",
      value: 0.72,
      comment: "below p25 for this model",
    });
    expect(r.ok).toBe(true);
  });

  test("rejects missing traceId", () => {
    const r = annotateObservation.validate({
      name: "agent:x",
      value: 1,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects empty traceId", () => {
    const r = annotateObservation.validate({
      traceId: "",
      name: "agent:x",
      value: 1,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects missing name", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      value: 1,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects missing value", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:x",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects value of wrong type (array)", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:x",
      value: [1, 2, 3],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects invalid dataType", () => {
    const r = annotateObservation.validate({
      traceId: "cc-123",
      name: "agent:x",
      value: 1,
      dataType: "INVALID",
    });
    expect(r.ok).toBe(false);
  });
});

describe("annotateObservation metadata", () => {
  test("name matches convention", () => {
    expect(annotateObservation.name).toBe("annotate-observation");
  });

  test("tier is full_llm (non-cacheable generative output)", () => {
    expect(annotateObservation.tier).toBe("full_llm");
  });

  test("allowedAgentTypes does NOT include trace-analyst (read-only)", () => {
    expect(annotateObservation.allowedAgentTypes).not.toContain(
      "trace-analyst",
    );
  });
});

// ─── execute() ────────────────────────────────────────────────────────────────

describe("annotateObservation.execute", () => {
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

  test("returns scoreId, traceId, name on success (NUMERIC)", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-num-001" }));
    const out = await annotateObservation.execute(
      { traceId: "cc-abc", name: "agent:confidence", value: 0.91 },
      CTX,
    );
    expect(out.scoreId).toBe("score-num-001");
    expect(out.traceId).toBe("cc-abc");
    expect(out.name).toBe("agent:confidence");
    expect(out.observationId).toBeNull();
  });

  test("returns scoreId for CATEGORICAL value", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-cat-002" }));
    const out = await annotateObservation.execute(
      {
        traceId: "cc-abc",
        name: "agent:class",
        value: "anomaly",
        dataType: "CATEGORICAL",
      },
      CTX,
    );
    expect(out.scoreId).toBe("score-cat-002");
  });

  test("returns scoreId for BOOLEAN value", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-bool-003" }));
    const out = await annotateObservation.execute(
      { traceId: "cc-abc", name: "agent:needs-review", value: true },
      CTX,
    );
    expect(out.scoreId).toBe("score-bool-003");
  });

  test("propagates observationId when provided", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-obs-004" }));
    const out = await annotateObservation.execute(
      {
        traceId: "cc-abc",
        observationId: "obs-xyz",
        name: "agent:latency",
        value: 1.5,
      },
      CTX,
    );
    expect(out.observationId).toBe("obs-xyz");
  });

  test("infers NUMERIC dataType for number value", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-infer" }));
    await annotateObservation.execute(
      { traceId: "cc-abc", name: "agent:score", value: 42 },
      CTX,
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.dataType).toBe("NUMERIC");
  });

  test("infers BOOLEAN dataType for boolean value", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-bool-infer" }));
    await annotateObservation.execute(
      { traceId: "cc-abc", name: "agent:flag", value: false },
      CTX,
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.dataType).toBe("BOOLEAN");
  });

  test("infers CATEGORICAL dataType for string value", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ id: "score-cat-infer" }));
    await annotateObservation.execute(
      { traceId: "cc-abc", name: "agent:label", value: "ok" },
      CTX,
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.dataType).toBe("CATEGORICAL");
  });

  test("throws on Langfuse API error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );
    await expect(
      annotateObservation.execute(
        { traceId: "cc-abc", name: "agent:x", value: 1 },
        CTX,
      ),
    ).rejects.toThrow("500");
  });
});
