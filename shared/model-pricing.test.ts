import { describe, expect, test } from "bun:test";
import { MODEL_PRICING, getPricing } from "./model-pricing";

describe("MODEL_PRICING", () => {
  test("contiene los tres familys y el default", () => {
    expect(MODEL_PRICING["claude-opus-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
    expect(MODEL_PRICING["default"]).toBeDefined();
  });

  test("opus tiene el precio más alto de output", () => {
    expect(MODEL_PRICING["claude-opus-4"]!.output).toBeGreaterThan(
      MODEL_PRICING["claude-sonnet-4"]!.output,
    );
    expect(MODEL_PRICING["claude-sonnet-4"]!.output).toBeGreaterThan(
      MODEL_PRICING["claude-haiku-4-5"]!.output,
    );
  });
});

describe("getPricing", () => {
  test("resuelve claude-opus-4-6 → opus pricing", () => {
    const p = getPricing("claude-opus-4-6");
    expect(p).toEqual(MODEL_PRICING["claude-opus-4"]!);
  });

  test("resuelve claude-opus-4-7 → opus pricing", () => {
    const p = getPricing("claude-opus-4-7");
    expect(p).toEqual(MODEL_PRICING["claude-opus-4"]!);
  });

  test("resuelve claude-sonnet-4-6 → sonnet pricing", () => {
    const p = getPricing("claude-sonnet-4-6");
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
});
