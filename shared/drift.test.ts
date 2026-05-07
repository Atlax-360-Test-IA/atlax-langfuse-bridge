import { describe, expect, test } from "bun:test";
import { classifyDrift, type DriftStatus } from "./drift";

const local = (
  turns: number,
  totalCost: number,
  end: string | null = "2026-04-26T10:00:00.000Z",
) => ({ turns, totalCost, end });

const remote = (
  turns: number,
  cost: number,
  end = "2026-04-26T10:00:00.000Z",
) => ({
  metadata: { turns, estimatedCostUSD: cost, sessionEnd: end },
});

describe("classifyDrift (shared/drift)", () => {
  test("returns OK when all fields match", () => {
    expect(classifyDrift(local(5, 0.05), remote(5, 0.05))).toBe("OK");
  });

  test("returns MISSING when remote is null", () => {
    expect(classifyDrift(local(5, 0.05), null)).toBe("MISSING");
  });

  test("returns TURNS_DRIFT when turns differ", () => {
    expect(classifyDrift(local(5, 0.05), remote(4, 0.05))).toBe("TURNS_DRIFT");
  });

  test("returns OK when remote has no metadata (null turns treated as mismatch)", () => {
    expect(
      classifyDrift(local(5, 0.05), { metadata: { estimatedCostUSD: 0.05 } }),
    ).toBe("TURNS_DRIFT");
  });

  test("returns COST_DRIFT when cost differs significantly", () => {
    expect(classifyDrift(local(5, 0.1), remote(5, 0.05))).toBe("COST_DRIFT");
  });

  test("returns OK for tiny cost diff (within COST_EPSILON)", () => {
    expect(classifyDrift(local(5, 0.055), remote(5, 0.05))).toBe("OK");
  });

  test("returns END_DRIFT when sessionEnd differs", () => {
    const r = remote(5, 0.05, "2026-04-25T09:00:00.000Z");
    expect(classifyDrift(local(5, 0.05, "2026-04-26T10:00:00.000Z"), r)).toBe(
      "END_DRIFT",
    );
  });

  test("TURNS_DRIFT takes priority over COST_DRIFT", () => {
    expect(classifyDrift(local(5, 0.1), remote(4, 0.05))).toBe("TURNS_DRIFT");
  });

  test("handles null metadata gracefully", () => {
    expect(classifyDrift(local(5, 0.05), { metadata: null })).toBe(
      "TURNS_DRIFT",
    );
  });

  test("type narrows correctly to DriftStatus", () => {
    const result: DriftStatus = classifyDrift(local(0, 0), null);
    expect(result).toBe("MISSING");
  });
});

describe("classifyDrift — COST_NOT_CALCULATED (generationCost param)", () => {
  const matchedRemote = remote(5, 0.05);
  const localWithCost = local(5, 0.05);
  const localZeroCost = local(5, 0);

  test("returns COST_NOT_CALCULATED when local cost > epsilon and generationCost is 0", () => {
    expect(classifyDrift(localWithCost, matchedRemote, 0)).toBe(
      "COST_NOT_CALCULATED",
    );
  });

  test("returns OK when generationCost is also positive (costs match)", () => {
    expect(classifyDrift(localWithCost, matchedRemote, 0.05)).toBe("OK");
  });

  test("returns OK when local cost is 0 (no cost to miss)", () => {
    // remote cost matches local (both 0) → no COST_DRIFT, no COST_NOT_CALCULATED
    const zeroRemote = remote(5, 0);
    expect(classifyDrift(localZeroCost, zeroRemote, 0)).toBe("OK");
  });

  test("returns OK when generationCost is null (API unavailable — degrade gracefully)", () => {
    expect(classifyDrift(localWithCost, matchedRemote, null)).toBe("OK");
  });

  test("returns OK when generationCost is undefined (param omitted — backward compat)", () => {
    expect(classifyDrift(localWithCost, matchedRemote)).toBe("OK");
  });

  test("TURNS_DRIFT takes priority over COST_NOT_CALCULATED", () => {
    const turnsMismatch = remote(4, 0.05);
    expect(classifyDrift(localWithCost, turnsMismatch, 0)).toBe("TURNS_DRIFT");
  });
});
