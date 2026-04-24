import { describe, expect, test } from "bun:test";
import { annotateObservation } from "./annotate-observation";

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
