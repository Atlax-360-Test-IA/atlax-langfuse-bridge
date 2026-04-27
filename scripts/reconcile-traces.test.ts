/**
 * Unit tests for reconcile-traces.ts — focuses on the exported pure functions.
 * replayHook() and discoverRecentJsonls() are subprocess/filesystem-heavy and
 * covered by the smoke E2E; main() requires credentials so it's excluded.
 */

import { describe, expect, test } from "bun:test";
import { classifyDrift, type DriftStatus } from "../shared/drift";
import { SAFE_SID_RE } from "./reconcile-traces";

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

describe("classifyDrift", () => {
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
