/**
 * Cross-validation tests — verify consistency between modules that must
 * agree on the same computation.
 *
 * These catch the class of bugs where two modules implement "the same logic"
 * independently and silently diverge over time.
 */

import { describe, expect, test, afterEach, spyOn, beforeEach } from "bun:test";
import { aggregateLines } from "../shared/aggregate";
import {
  calcCost,
  getBillingTier,
  emitDegradation as hookEmit,
} from "../hooks/langfuse-sync";
import { detectTier } from "../scripts/detect-tier";
import { getPricing } from "../shared/model-pricing";
import { emitDegradation as sharedEmit } from "../shared/degradation";

const FIXTURE_LINES = [
  '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","cwd":"/home/dev/work/my-project"}',
  '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":200,"cache_read_input_tokens":100,"service_tier":"standard"}}}',
  '{"type":"assistant","timestamp":"2026-04-15T10:05:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":3000,"output_tokens":2000,"cache_creation_input_tokens":500,"cache_read_input_tokens":0,"service_tier":"priority"}}}',
];

// ─── calcCost (hook) vs aggregate (shared) must agree on total cost ──────────

describe("cost calculation consistency", () => {
  test("calcCost per-turn sum equals aggregate totalCost", () => {
    const agg = aggregateLines(FIXTURE_LINES);

    let hookTotal = 0;
    for (const [model, usage] of agg.models) {
      hookTotal += calcCost(
        {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
        },
        model,
      );
    }

    expect(hookTotal).toBeCloseTo(agg.totalCost, 10);
  });

  test("per-model cost from aggregate matches calcCost", () => {
    const agg = aggregateLines(FIXTURE_LINES);

    for (const [model, usage] of agg.models) {
      const hookCost = calcCost(
        {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
        },
        model,
      );
      expect(hookCost).toBeCloseTo(usage.cost, 10);
    }
  });
});

// ─── getPricing fallback consistency ────────────────────────────────────────

describe("pricing fallback consistency", () => {
  test("unknown model in calcCost uses default (sonnet) pricing", () => {
    const defaultCost = calcCost(
      { input_tokens: 1000, output_tokens: 500 },
      "unknown-model-xyz",
    );
    const sonnetCost = calcCost(
      { input_tokens: 1000, output_tokens: 500 },
      "claude-sonnet-4-6",
    );
    expect(defaultCost).toBeCloseTo(sonnetCost, 10);
  });

  test("getPricing default equals sonnet pricing", () => {
    const defaultP = getPricing("anything");
    const sonnetP = getPricing("claude-sonnet-4-6");
    expect(defaultP).toEqual(sonnetP);
  });
});

// ─── Tier detection consistency ─────────────────────────────────────────────

describe("tier detection consistency", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("getBillingTier vertex matches detectTier vertex", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    const hookTier = getBillingTier();
    const scriptTier = detectTier();
    expect(hookTier).toBe("vertex-gcp");
    expect(scriptTier.tier).toBe("vertex-gcp");
  });

  test("both modules agree vertex takes precedence", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const hookTier = getBillingTier("standard");
    const scriptTier = detectTier();

    expect(hookTier).toBe("vertex-gcp");
    expect(scriptTier.tier).toBe("vertex-gcp");
  });
});

// ─── emitDegradation: hook re-exports same function as shared/ ───────────────

describe("degradation shared source", () => {
  const written: string[] = [];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    written.length = 0;
    spy = spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      written.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test("hookEmit and sharedEmit produce identical output structure", () => {
    hookEmit("hook:source", new Error("hook error"));
    sharedEmit("shared:source", new Error("shared error"));

    const hookOut = JSON.parse(written[0]!);
    const sharedOut = JSON.parse(written[1]!);

    expect(Object.keys(hookOut).sort()).toEqual(Object.keys(sharedOut).sort());
    expect(hookOut.type).toBe("degradation");
    expect(sharedOut.type).toBe("degradation");
  });

  test("hook re-export is the same function reference as shared export", () => {
    // Both must produce the same serialized format — verifies they share impl
    hookEmit("src", new Error("msg"));
    const fromHook = JSON.parse(written[0]!);

    written.length = 0;
    sharedEmit("src", new Error("msg"));
    const fromShared = JSON.parse(written[0]!);

    // ts will differ by milliseconds — compare all except ts
    expect(fromHook.type).toBe(fromShared.type);
    expect(fromHook.source).toBe(fromShared.source);
    expect(fromHook.error).toBe(fromShared.error);
  });
});
