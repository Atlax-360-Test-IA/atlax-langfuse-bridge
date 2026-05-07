import { describe, expect, test } from "bun:test";
import { MODEL_PRICING, getPricing, estimateCost } from "./pricing.js";
import { MODEL_PRICING as TS_PRICING } from "../../shared/model-pricing";

// ─── Cross-validation con shared/model-pricing.ts (I-6 invariante) ──────────

describe("extension pricing mirrors shared/model-pricing.ts", () => {
  test("exports the same model keys", () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual(
      Object.keys(TS_PRICING).sort(),
    );
  });

  test("each model has identical input/output/cache prices", () => {
    for (const key of Object.keys(TS_PRICING)) {
      const ts = TS_PRICING[key];
      const js = MODEL_PRICING[key];
      expect(js).toBeDefined();
      expect(js!.input).toBe(ts!.input);
      expect(js!.output).toBe(ts!.output);
      expect(js!.cacheRead).toBe(ts!.cacheRead);
      expect(js!.cacheWrite).toBe(ts!.cacheWrite);
    }
  });
});

// ─── getPricing ──────────────────────────────────────────────────────────────

describe("getPricing", () => {
  test("Opus 4.7 usa el pricing nuevo $5/$25 (no el legacy $15/$75)", () => {
    const p = getPricing("claude-opus-4-7");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  test("matches sonnet variants", () => {
    expect(getPricing("claude-sonnet-4-6")).toEqual(
      MODEL_PRICING["claude-sonnet-4"],
    );
  });

  test("matches haiku exact key", () => {
    expect(getPricing("claude-haiku-4-5-20251001")).toEqual(
      MODEL_PRICING["claude-haiku-4-5"],
    );
  });

  test("falls back to default for unknown model", () => {
    expect(getPricing("claude-unknown-99")).toEqual(MODEL_PRICING.default);
  });

  test("null/undefined model returns default", () => {
    expect(getPricing(null)).toEqual(MODEL_PRICING.default);
    expect(getPricing(undefined)).toEqual(MODEL_PRICING.default);
  });
});

// ─── estimateCost ────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  test("computes opus 4.7 cost correctly (nuevo pricing $5/$25)", () => {
    // 1M input + 1M output @ opus 4.7 = 5 + 25 = 30
    expect(estimateCost("claude-opus-4-7", 1_000_000, 1_000_000)).toBeCloseTo(
      30,
      6,
    );
  });

  test("computes opus 4.1 cost correctly (legacy pricing $15/$75)", () => {
    // 1M input + 1M output @ opus 4.1 = 15 + 75 = 90
    expect(estimateCost("claude-opus-4-1", 1_000_000, 1_000_000)).toBeCloseTo(
      90,
      6,
    );
  });

  test("computes sonnet cost correctly", () => {
    // 1M input + 1M output @ sonnet = 3 + 15 = 18
    expect(estimateCost("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(
      18,
      6,
    );
  });

  test("zero tokens → zero cost", () => {
    expect(estimateCost("claude-opus-4", 0, 0)).toBe(0);
  });

  test("null/undefined tokens treated as 0", () => {
    expect(estimateCost("claude-opus-4", null, null)).toBe(0);
    expect(estimateCost("claude-opus-4", undefined, undefined)).toBe(0);
  });

  test("unknown model uses default (sonnet) pricing", () => {
    const def = estimateCost("unknown-model", 1_000_000, 1_000_000);
    const sonnet = estimateCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(def).toBeCloseTo(sonnet, 6);
  });

  test("realistic claude.ai turn (small)", () => {
    // 10k input + 2k output @ sonnet
    // = (10_000 * 3 + 2_000 * 15) / 1_000_000
    // = (30_000 + 30_000) / 1_000_000 = 0.06
    expect(estimateCost("claude-sonnet-4-6", 10_000, 2_000)).toBeCloseTo(
      0.06,
      6,
    );
  });
});
