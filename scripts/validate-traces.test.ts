/**
 * Unit tests for validate-traces.ts — focuses on the exported classifyDrift
 * function. main() requires Langfuse credentials and is excluded from CI.
 */

import { describe, expect, test } from "bun:test";
import { classifyDrift, type DriftStatus } from "./validate-traces";

// ─── classifyDrift ────────────────────────────────────────────────────────────

const local = (
  turns: number,
  totalCost: number,
  end: string | null = "2026-04-26T10:00:00.000Z",
) => ({ turns, totalCost, end });

const remote = (
  turns: number,
  estimatedCostUSD: number,
  sessionEnd: string | null = "2026-04-26T10:00:00.000Z",
) => ({ metadata: { turns, estimatedCostUSD, sessionEnd } });

describe("classifyDrift (validate-traces)", () => {
  test("OK when turns, cost, and end all match", () => {
    expect(classifyDrift(local(3, 0.03), remote(3, 0.03))).toBe("OK");
  });

  test("MISSING when remote is null", () => {
    expect(classifyDrift(local(3, 0.03), null)).toBe("MISSING");
  });

  test("TURNS_DRIFT when remote turns differ", () => {
    expect(classifyDrift(local(3, 0.03), remote(2, 0.03))).toBe("TURNS_DRIFT");
  });

  test("COST_DRIFT when cost delta exceeds 0.01 epsilon", () => {
    expect(classifyDrift(local(3, 0.15), remote(3, 0.03))).toBe("COST_DRIFT");
  });

  test("OK when cost is within epsilon tolerance", () => {
    expect(classifyDrift(local(3, 0.035), remote(3, 0.03))).toBe("OK");
  });

  test("END_DRIFT when sessionEnd timestamps differ", () => {
    const r = remote(3, 0.03, "2026-04-26T12:00:00.000Z");
    expect(classifyDrift(local(3, 0.03, "2026-04-26T10:00:00.000Z"), r)).toBe(
      "END_DRIFT",
    );
  });

  test("TURNS_DRIFT has higher priority than COST_DRIFT", () => {
    expect(classifyDrift(local(3, 0.15), remote(2, 0.03))).toBe("TURNS_DRIFT");
  });

  test("COST_DRIFT has higher priority than END_DRIFT", () => {
    const r = remote(3, 0.03, "2026-04-26T12:00:00.000Z");
    expect(classifyDrift(local(3, 0.15, "2026-04-26T10:00:00.000Z"), r)).toBe(
      "COST_DRIFT",
    );
  });

  test("remote with null metadata → TURNS_DRIFT (turns missing)", () => {
    expect(classifyDrift(local(3, 0.03), { metadata: null })).toBe(
      "TURNS_DRIFT",
    );
  });

  test("local end=null and remote sessionEnd=null → OK", () => {
    const result: DriftStatus = classifyDrift(
      { turns: 3, totalCost: 0.03, end: null },
      remote(3, 0.03, null),
    );
    expect(result).toBe("OK");
  });

  test("local end=undefined and remote sessionEnd=null → END_DRIFT", () => {
    const result: DriftStatus = classifyDrift(
      { turns: 3, totalCost: 0.03, end: undefined },
      remote(3, 0.03, null),
    );
    expect(result).toBe("END_DRIFT");
  });
});
