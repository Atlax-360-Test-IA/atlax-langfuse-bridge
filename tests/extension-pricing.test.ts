/**
 * Cross-validation: browser-extension/src/pricing.js must stay in sync with
 * shared/model-pricing.ts (invariante I-6). This test is the enforcement
 * mechanism referenced in browser-extension/src/pricing.js:7.
 */

import { describe, expect, test } from "bun:test";
import { MODEL_PRICING as TS_PRICING } from "../shared/model-pricing";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pricing.js is intentionally plain JS with no type declaration
import { MODEL_PRICING as JS_PRICING } from "../browser-extension/src/pricing.js";

const FIELDS = ["input", "cacheWrite", "cacheRead", "output"] as const;

describe("extension pricing.js ↔ shared/model-pricing.ts sync (I-6)", () => {
  test("both files export the same model keys", () => {
    const tsKeys = Object.keys(TS_PRICING).sort();
    const jsKeys = Object.keys(JS_PRICING).sort();
    expect(jsKeys).toEqual(tsKeys);
  });

  test("each model has identical pricing values in both files", () => {
    for (const model of Object.keys(TS_PRICING)) {
      const ts = TS_PRICING[model]!;
      const js = (JS_PRICING as Record<string, typeof ts>)[model];
      expect(js).toBeDefined();
      for (const field of FIELDS) {
        expect(js![field]).toBe(ts[field]);
      }
    }
  });

  test("default pricing matches between files", () => {
    const ts = TS_PRICING["default"]!;
    const js = (JS_PRICING as Record<string, typeof ts>)["default"]!;
    for (const field of FIELDS) {
      expect(js[field]).toBe(ts[field]);
    }
  });

  test("no extra model in pricing.js that is missing from model-pricing.ts", () => {
    const tsKeys = new Set(Object.keys(TS_PRICING));
    for (const key of Object.keys(JS_PRICING)) {
      expect(tsKeys.has(key)).toBe(true);
    }
  });
});
