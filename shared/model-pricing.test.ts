import { describe, expect, test } from "bun:test";
import { MODEL_PRICING, getPricing } from "./model-pricing";

describe("MODEL_PRICING", () => {
  test("contiene entradas modernas + legacy + default", () => {
    expect(MODEL_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-5"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-1"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
    expect(MODEL_PRICING["default"]).toBeDefined();
  });

  test("Opus 4.5+ usa el pricing nuevo ($5/$25), no el legacy ($15/$75)", () => {
    // Regresión: substring match producía silenciosamente $15/$75 en
    // Opus 4.7/4.6/4.5, sobrestimando coste por 3×.
    for (const id of [
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
    ]) {
      expect(MODEL_PRICING[id]!.input).toBe(5);
      expect(MODEL_PRICING[id]!.output).toBe(25);
      expect(MODEL_PRICING[id]!.cacheRead).toBe(0.5);
      expect(MODEL_PRICING[id]!.cacheWrite).toBe(6.25);
    }
  });

  test("Opus 4.1 / 4.0 mantienen pricing legacy ($15/$75)", () => {
    expect(MODEL_PRICING["claude-opus-4-1"]!.input).toBe(15);
    expect(MODEL_PRICING["claude-opus-4-1"]!.output).toBe(75);
    expect(MODEL_PRICING["claude-opus-4"]!.input).toBe(15);
    expect(MODEL_PRICING["claude-opus-4"]!.output).toBe(75);
  });

  test("Sonnet 4 pricing $3/$15 con cache ratios estándar", () => {
    const p = MODEL_PRICING["claude-sonnet-4"]!;
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
    expect(p.cacheRead).toBeCloseTo(0.3);
    expect(p.cacheWrite).toBeCloseTo(3.75);
  });

  test("Haiku 4.5 pricing $1/$5 con cache ratios estándar", () => {
    const p = MODEL_PRICING["claude-haiku-4-5"]!;
    expect(p.input).toBe(1);
    expect(p.output).toBe(5);
    expect(p.cacheRead).toBeCloseTo(0.1);
    expect(p.cacheWrite).toBeCloseTo(1.25);
  });

  test("ratios cache match official Anthropic multipliers (1.25× write, 0.1× read)", () => {
    // Anthropic publica: cache write 5min = 1.25× input, cache read = 0.1× input
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      if (id === "default") continue;
      expect(p.cacheWrite / p.input).toBeCloseTo(1.25, 2);
      expect(p.cacheRead / p.input).toBeCloseTo(0.1, 2);
    }
  });
});

describe("getPricing", () => {
  test("resuelve claude-opus-4-7 → pricing nuevo $5/$25", () => {
    const p = getPricing("claude-opus-4-7");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  test("resuelve claude-opus-4-6 → pricing nuevo $5/$25", () => {
    const p = getPricing("claude-opus-4-6");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  test("resuelve claude-opus-4-5 → pricing nuevo $5/$25", () => {
    const p = getPricing("claude-opus-4-5");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  test("resuelve claude-opus-4-1 → pricing legacy $15/$75", () => {
    const p = getPricing("claude-opus-4-1");
    expect(p.input).toBe(15);
    expect(p.output).toBe(75);
  });

  test("resuelve claude-opus-4-1-20260101 (con fecha) → legacy", () => {
    const p = getPricing("claude-opus-4-1-20260101");
    expect(p.input).toBe(15);
  });

  test("resuelve claude-opus-4-7-20260417 (con fecha) → pricing nuevo", () => {
    const p = getPricing("claude-opus-4-7-20260417");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  test("longest-key-first ordering: Opus 4.7 NO matches 'claude-opus-4' legacy", () => {
    // El bug original: "claude-opus-4-7".includes("claude-opus-4") === true
    // Si las keys no se ordenan longest-first, Opus 4.7 caería en el bucket
    // legacy de $15/$75. Este test es el guard contra esa regresión.
    const p = getPricing("claude-opus-4-7");
    expect(p.input).not.toBe(15);
    expect(p.output).not.toBe(75);
  });

  test("resuelve claude-sonnet-4-6 → sonnet pricing", () => {
    const p = getPricing("claude-sonnet-4-6");
    expect(p).toEqual(MODEL_PRICING["claude-sonnet-4"]!);
  });

  test("resuelve claude-sonnet-4-5 → sonnet pricing", () => {
    const p = getPricing("claude-sonnet-4-5");
    expect(p).toEqual(MODEL_PRICING["claude-sonnet-4"]!);
  });

  test("resuelve claude-haiku-4-5-20251001 → haiku pricing", () => {
    const p = getPricing("claude-haiku-4-5-20251001");
    expect(p).toEqual(MODEL_PRICING["claude-haiku-4-5"]!);
  });

  test("modelo desconocido → fallback default (sonnet pricing)", () => {
    const p = getPricing("gpt-4o");
    expect(p).toEqual(MODEL_PRICING["default"]!);
  });

  test("string vacío → fallback default", () => {
    const p = getPricing("");
    expect(p).toEqual(MODEL_PRICING["default"]!);
  });

  test("'unknown' → fallback default", () => {
    const p = getPricing("unknown");
    expect(p).toEqual(MODEL_PRICING["default"]!);
  });

  test("input no-string → fallback default sin throw", () => {
    const p = getPricing(null as unknown as string);
    expect(p).toEqual(MODEL_PRICING["default"]!);
  });
});
