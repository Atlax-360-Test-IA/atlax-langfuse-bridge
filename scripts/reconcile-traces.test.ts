/**
 * Unit tests for reconcile-traces.ts — focuses on the exported pure functions.
 * replayHook() and discoverRecentJsonls() are subprocess/filesystem-heavy and
 * covered by the smoke E2E; main() requires credentials so it's excluded.
 */

import { describe, expect, test } from "bun:test";
import { classifyDrift, type DriftStatus } from "../shared/drift";
import {
  SAFE_SID_RE,
  familyKey,
  computeReportRange,
  compareCostByModel,
  isSeatOnlyScenario,
  DEFAULT_COST_DIVERGENCE_THRESHOLD,
} from "./reconcile-traces";

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
) => ({
  metadata: { turns, estimatedCostUSD, sessionEnd },
});

describe("classifyDrift — I-11: source is shared/drift.ts", () => {
  test("OK when all fields match", () => {
    expect(classifyDrift(local(5, 0.05), remote(5, 0.05))).toBe("OK");
  });

  test("MISSING when remote is null", () => {
    expect(classifyDrift(local(5, 0.05), null)).toBe("MISSING");
  });

  test("TURNS_DRIFT when remote turns differ", () => {
    expect(classifyDrift(local(5, 0.05), remote(4, 0.05))).toBe("TURNS_DRIFT");
  });

  test("TURNS_DRIFT when remote metadata lacks turns", () => {
    expect(
      classifyDrift(local(5, 0.05), { metadata: { estimatedCostUSD: 0.05 } }),
    ).toBe("TURNS_DRIFT");
  });

  test("COST_DRIFT when cost difference exceeds epsilon (0.01)", () => {
    expect(classifyDrift(local(5, 0.1), remote(5, 0.05))).toBe("COST_DRIFT");
  });

  test("OK when cost difference is within epsilon", () => {
    expect(classifyDrift(local(5, 0.055), remote(5, 0.05))).toBe("OK");
  });

  test("END_DRIFT when sessionEnd differs", () => {
    const r = remote(5, 0.05, "2026-04-26T11:00:00.000Z");
    expect(classifyDrift(local(5, 0.05, "2026-04-26T10:00:00.000Z"), r)).toBe(
      "END_DRIFT",
    );
  });

  test("TURNS_DRIFT takes priority over COST_DRIFT", () => {
    expect(classifyDrift(local(5, 0.1), remote(4, 0.05))).toBe("TURNS_DRIFT");
  });

  test("COST_DRIFT takes priority over END_DRIFT", () => {
    const r = remote(5, 0.05, "2026-04-26T11:00:00.000Z");
    expect(classifyDrift(local(5, 0.1, "2026-04-26T10:00:00.000Z"), r)).toBe(
      "COST_DRIFT",
    );
  });

  test("handles remote with null metadata gracefully — TURNS_DRIFT (turns=null≠local)", () => {
    expect(classifyDrift(local(5, 0.05), { metadata: null })).toBe(
      "TURNS_DRIFT",
    );
  });

  test("handles local end=undefined (matches remote null → END_DRIFT)", () => {
    const result = classifyDrift(
      { turns: 5, totalCost: 0.05, end: undefined },
      remote(5, 0.05, null),
    );
    // undefined !== null → END_DRIFT
    expect(result).toBe("END_DRIFT");
  });

  test("handles local end=null matching remote null → OK", () => {
    const result = classifyDrift(
      { turns: 5, totalCost: 0.05, end: null },
      remote(5, 0.05, null),
    );
    expect(result).toBe("OK");
  });

  test("MISSING returns immediately regardless of metadata presence", () => {
    const result: DriftStatus = classifyDrift(local(0, 0), null);
    expect(result).toBe("MISSING");
  });
});

// ─── SAFE_SID_RE (C4: path traversal prevention) ─────────────────────────────

describe("SAFE_SID_RE", () => {
  test("accepts standard UUID format", () => {
    expect(SAFE_SID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("accepts alphanumeric with underscores and hyphens", () => {
    expect(SAFE_SID_RE.test("abc123_def-456")).toBe(true);
  });

  test("rejects path traversal sequences", () => {
    expect(SAFE_SID_RE.test("../secret")).toBe(false);
    expect(SAFE_SID_RE.test("../../etc/passwd")).toBe(false);
  });

  test("rejects slashes", () => {
    expect(SAFE_SID_RE.test("foo/bar")).toBe(false);
  });

  test("rejects dots", () => {
    expect(SAFE_SID_RE.test("foo.bar")).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(SAFE_SID_RE.test("foo\x00bar")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(SAFE_SID_RE.test("foo bar")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(SAFE_SID_RE.test("")).toBe(false);
  });
});

// ─── S18-B/D: cost report comparison helpers ────────────────────────────────

describe("familyKey — model normalization", () => {
  test("date suffix maps to base key (haiku-4-5-20251001 → haiku-4-5)", () => {
    expect(familyKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("opus 4.7 does NOT collapse to opus-4 (longest-first match)", () => {
    expect(familyKey("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  test("sonnet 4.6 does NOT collapse to sonnet-4 (longest-first match)", () => {
    expect(familyKey("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  test("bare claude-opus-4 stays as opus-4 (legacy pricing)", () => {
    expect(familyKey("claude-opus-4-20250514")).toBe("claude-opus-4");
  });

  test("unknown model returns input unchanged", () => {
    expect(familyKey("claude-future-99")).toBe("claude-future-99");
  });
});

describe("computeReportRange — UTC day-aligned bounds", () => {
  test("single day → 00:00 to next 00:00", () => {
    const r = computeReportRange(["2026-05-07T15:30:00.000Z"]);
    expect(r).not.toBeNull();
    expect(r!.startingAt).toBe("2026-05-07T00:00:00Z");
    expect(r!.endingAt).toBe("2026-05-08T00:00:00Z");
  });

  test("multiple sessions span full days", () => {
    const r = computeReportRange([
      "2026-05-05T08:00:00.000Z",
      "2026-05-07T22:00:00.000Z",
      "2026-05-06T14:00:00.000Z",
    ]);
    expect(r!.startingAt).toBe("2026-05-05T00:00:00Z");
    expect(r!.endingAt).toBe("2026-05-08T00:00:00Z");
  });

  test("returns null for empty array", () => {
    expect(computeReportRange([])).toBeNull();
  });

  test("ignores invalid timestamps", () => {
    const r = computeReportRange([
      "not-a-date",
      "2026-05-07T15:00:00.000Z",
      "",
    ]);
    expect(r!.startingAt).toBe("2026-05-07T00:00:00Z");
  });

  test("returns null when all timestamps invalid", () => {
    expect(computeReportRange(["nope", "also-nope"])).toBeNull();
  });
});

describe("compareCostByModel — divergence detection", () => {
  const THRESH = 0.05;
  const MIN_USD = 0.1;

  test("estimated and real within threshold → exceedsThreshold false", () => {
    const est = new Map([["claude-sonnet-4-6", 100]]);
    const real = new Map([["claude-sonnet-4-6", 102]]); // 2% diff
    const rows = compareCostByModel(est, real, THRESH, MIN_USD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exceedsThreshold).toBe(false);
    expect(rows[0]!.divergencePct).toBeCloseTo(0.0196, 3);
  });

  test("real diverges >5% from estimated → exceedsThreshold true", () => {
    const est = new Map([["claude-sonnet-4-6", 100]]);
    const real = new Map([["claude-sonnet-4-6", 110]]); // 9% diff
    const rows = compareCostByModel(est, real, THRESH, MIN_USD);
    expect(rows[0]!.exceedsThreshold).toBe(true);
    expect(rows[0]!.divergencePct).toBeCloseTo(0.0909, 3);
  });

  test("model only in real (no local estimate) appears with est=0", () => {
    const est = new Map<string, number>();
    const real = new Map([["claude-haiku-4-5", 5]]);
    const rows = compareCostByModel(est, real, THRESH, MIN_USD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.estimatedUSD).toBe(0);
    expect(rows[0]!.realUSD).toBe(5);
    expect(rows[0]!.exceedsThreshold).toBe(true);
  });

  test("rows below MIN_USD on both sides are filtered out (noise)", () => {
    const est = new Map([["claude-haiku-4-5", 0.05]]);
    const real = new Map([["claude-haiku-4-5", 0.06]]);
    const rows = compareCostByModel(est, real, THRESH, MIN_USD);
    expect(rows).toHaveLength(0);
  });

  test("row above MIN_USD on either side is kept", () => {
    const est = new Map([["claude-sonnet-4-6", 0.5]]);
    const real = new Map([["claude-sonnet-4-6", 0.05]]);
    const rows = compareCostByModel(est, real, THRESH, MIN_USD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exceedsThreshold).toBe(true);
  });

  test("DEFAULT_COST_DIVERGENCE_THRESHOLD is 5%", () => {
    expect(DEFAULT_COST_DIVERGENCE_THRESHOLD).toBe(0.05);
  });
});

describe("isSeatOnlyScenario — Premium seat detection", () => {
  test("all rows with realUSD=0 and estimated>0 → true", () => {
    expect(
      isSeatOnlyScenario([
        { estimatedUSD: 100, realUSD: 0 },
        { estimatedUSD: 50, realUSD: 0 },
      ]),
    ).toBe(true);
  });

  test("any row with realUSD>0 → false", () => {
    expect(
      isSeatOnlyScenario([
        { estimatedUSD: 100, realUSD: 0 },
        { estimatedUSD: 50, realUSD: 5 },
      ]),
    ).toBe(false);
  });

  test("empty rows → false (no signal at all)", () => {
    expect(isSeatOnlyScenario([])).toBe(false);
  });

  test("all rows zero on both sides → false", () => {
    expect(isSeatOnlyScenario([{ estimatedUSD: 0, realUSD: 0 }])).toBe(false);
  });
});
