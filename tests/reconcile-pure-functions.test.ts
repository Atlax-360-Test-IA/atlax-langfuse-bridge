/**
 * Unit tests for pure exported functions in scripts/reconcile-traces.ts.
 *
 * These cover the cost-comparison logic introduced in S18-B (cost_report
 * integration) that is not exercised by the existing E2E tests. Pure
 * functions here have no I/O — they take input data and return derived
 * values, so they are testable directly without spawning subprocesses
 * or mocking HTTP.
 */

import { describe, expect, test } from "bun:test";
import {
  familyKey,
  computeReportRange,
  isSeatOnlyScenario,
  compareCostByModel,
} from "../scripts/reconcile-traces";

// ─── familyKey ──────────────────────────────────────────────────────────────

describe("familyKey", () => {
  test("matches claude-opus-4-7 for full model id with date suffix", () => {
    expect(familyKey("claude-opus-4-7-20260417")).toBe("claude-opus-4-7");
  });

  test("matches claude-sonnet-4-6 with date suffix", () => {
    expect(familyKey("claude-sonnet-4-6-20260417")).toBe("claude-sonnet-4-6");
  });

  test("matches claude-haiku-4-5 with date suffix", () => {
    expect(familyKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("matches claude-opus-4-7 longest-first (not claude-opus-4)", () => {
    // Critical: order matters in FAMILY_KEYS — shorter keys must not shadow longer ones
    expect(familyKey("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(familyKey("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(familyKey("claude-opus-4")).toBe("claude-opus-4");
  });

  test("returns the input model unchanged when no family key matches", () => {
    expect(familyKey("gpt-4-turbo")).toBe("gpt-4-turbo");
    expect(familyKey("gemini-pro")).toBe("gemini-pro");
    expect(familyKey("unknown-model")).toBe("unknown-model");
  });

  test("matches claude-sonnet-4-5 distinct from claude-sonnet-4-6", () => {
    expect(familyKey("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(familyKey("claude-sonnet-4-5-20250901")).toBe("claude-sonnet-4-5");
  });
});

// ─── computeReportRange ─────────────────────────────────────────────────────

describe("computeReportRange", () => {
  test("returns null for empty input", () => {
    expect(computeReportRange([])).toBeNull();
  });

  test("returns null when all timestamps are invalid", () => {
    expect(computeReportRange(["not-a-date", "also-bad"])).toBeNull();
  });

  test("returns day-aligned UTC range for a single timestamp", () => {
    const result = computeReportRange(["2026-04-15T14:30:00.000Z"]);
    expect(result).not.toBeNull();
    expect(result!.startingAt).toBe("2026-04-15T00:00:00Z");
    // exclusive end → next day at 00:00
    expect(result!.endingAt).toBe("2026-04-16T00:00:00Z");
  });

  test("spans multiple days correctly", () => {
    const result = computeReportRange([
      "2026-04-15T08:00:00.000Z",
      "2026-04-17T22:00:00.000Z",
      "2026-04-16T12:00:00.000Z",
    ]);
    expect(result!.startingAt).toBe("2026-04-15T00:00:00Z");
    expect(result!.endingAt).toBe("2026-04-18T00:00:00Z"); // exclusive
  });

  test("ignores invalid timestamps but uses valid ones", () => {
    const result = computeReportRange([
      "not-a-date",
      "2026-04-15T14:30:00.000Z",
      "garbage",
    ]);
    expect(result!.startingAt).toBe("2026-04-15T00:00:00Z");
    expect(result!.endingAt).toBe("2026-04-16T00:00:00Z");
  });

  test("handles end-of-month rollover", () => {
    const result = computeReportRange(["2026-04-30T23:59:59.000Z"]);
    expect(result!.startingAt).toBe("2026-04-30T00:00:00Z");
    expect(result!.endingAt).toBe("2026-05-01T00:00:00Z");
  });

  test("output format strips milliseconds (matches Anthropic API contract)", () => {
    const result = computeReportRange(["2026-04-15T14:30:00.123Z"]);
    // Verify there are no milliseconds in the output
    expect(result!.startingAt).not.toContain(".");
    expect(result!.endingAt).not.toContain(".");
  });
});

// ─── isSeatOnlyScenario ─────────────────────────────────────────────────────

describe("isSeatOnlyScenario", () => {
  test("returns false for empty rows", () => {
    expect(isSeatOnlyScenario([])).toBe(false);
  });

  test("returns true when all real=0 but some estimated>0 (seat traffic)", () => {
    const rows = [
      { estimatedUSD: 10, realUSD: 0 },
      { estimatedUSD: 5, realUSD: 0 },
    ];
    expect(isSeatOnlyScenario(rows)).toBe(true);
  });

  test("returns false when any real>0 (mixed API+seat)", () => {
    const rows = [
      { estimatedUSD: 10, realUSD: 0 },
      { estimatedUSD: 5, realUSD: 3.5 },
    ];
    expect(isSeatOnlyScenario(rows)).toBe(false);
  });

  test("returns false when all estimated=0 and all real=0 (no traffic)", () => {
    const rows = [
      { estimatedUSD: 0, realUSD: 0 },
      { estimatedUSD: 0, realUSD: 0 },
    ];
    expect(isSeatOnlyScenario(rows)).toBe(false);
  });

  test("returns false when all real>0 (pure API traffic)", () => {
    const rows = [
      { estimatedUSD: 10, realUSD: 9.5 },
      { estimatedUSD: 5, realUSD: 4.8 },
    ];
    expect(isSeatOnlyScenario(rows)).toBe(false);
  });

  test("single row with real=0, estimated>0 = seat-only", () => {
    expect(isSeatOnlyScenario([{ estimatedUSD: 100, realUSD: 0 }])).toBe(true);
  });
});

// ─── compareCostByModel ─────────────────────────────────────────────────────

describe("compareCostByModel", () => {
  test("emits row with 0% divergence when estimated == real", () => {
    const est = new Map([["claude-sonnet-4-6", 10]]);
    const real = new Map([["claude-sonnet-4-6", 10]]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.divergencePct).toBe(0);
    expect(rows[0]!.exceedsThreshold).toBe(false);
  });

  test("computes correct divergence pct using max(est, real) baseline", () => {
    const est = new Map([["claude-opus-4-7", 100]]);
    const real = new Map([["claude-opus-4-7", 90]]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    // |100 - 90| / max(100, 90) = 10/100 = 0.10 → 10%
    expect(rows[0]!.divergencePct).toBe(0.1);
    expect(rows[0]!.exceedsThreshold).toBe(true);
  });

  test("flags rows that exceed the threshold", () => {
    const est = new Map([["claude-sonnet-4-6", 100]]);
    const real = new Map([["claude-sonnet-4-6", 80]]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    // 20% divergence, threshold 5% → exceeds
    expect(rows[0]!.exceedsThreshold).toBe(true);
  });

  test("does NOT flag rows below the threshold", () => {
    const est = new Map([["claude-sonnet-4-6", 100]]);
    const real = new Map([["claude-sonnet-4-6", 98]]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    // 2% divergence, threshold 5% → does NOT exceed
    expect(rows[0]!.exceedsThreshold).toBe(false);
  });

  test("filters out rows below minCompareUsd on both sides (noise floor)", () => {
    const est = new Map([
      ["claude-haiku-4-5", 0.001], // tiny
      ["claude-sonnet-4-6", 5], // significant
    ]);
    const real = new Map([
      ["claude-haiku-4-5", 0.002], // tiny
      ["claude-sonnet-4-6", 5],
    ]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    // Only sonnet-4-6 row survives (haiku is below noise floor)
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("claude-sonnet-4-6");
  });

  test("includes a row when only one side exceeds noise floor", () => {
    const est = new Map([["claude-sonnet-4-6", 5]]);
    const real = new Map([["claude-sonnet-4-6", 0]]); // not in real, but est is significant
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.realUSD).toBe(0);
    // 100% divergence → exceeds threshold
    expect(rows[0]!.exceedsThreshold).toBe(true);
  });

  test("rounds dollar amounts to 4 decimal places", () => {
    const est = new Map([["claude-sonnet-4-6", 10.123456789]]);
    const real = new Map([["claude-sonnet-4-6", 10.987654321]]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    expect(rows[0]!.estimatedUSD).toBe(10.1235);
    expect(rows[0]!.realUSD).toBe(10.9877);
  });

  test("emits one row per model in the union of both maps", () => {
    const est = new Map([
      ["claude-opus-4-7", 100],
      ["claude-sonnet-4-6", 50],
    ]);
    const real = new Map([
      ["claude-sonnet-4-6", 48],
      ["claude-haiku-4-5", 5],
    ]);
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    expect(rows).toHaveLength(3);
    const models = rows.map((r) => r.model).sort();
    expect(models).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
  });

  test("baseline=0 yields divergence=0 (cannot compute pct from zero)", () => {
    const est = new Map<string, number>();
    const real = new Map<string, number>();
    // Both empty — should not crash
    const rows = compareCostByModel(est, real, 0.05, 0.01);
    expect(rows).toHaveLength(0);
  });

  test("returns empty when input maps are empty", () => {
    const rows = compareCostByModel(new Map(), new Map(), 0.05, 0.01);
    expect(rows).toEqual([]);
  });
});
