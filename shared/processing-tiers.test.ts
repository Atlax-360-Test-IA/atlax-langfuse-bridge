import { describe, expect, test } from "bun:test";
import {
  getTier,
  getTierMetadata,
  TIER_METADATA,
  HOOK_TIER_MAP,
  type ProcessingTier,
} from "./processing-tiers";

describe("HOOK_TIER_MAP", () => {
  test("core pipeline hooks are deterministic (zero LLM cost)", () => {
    const deterministic = [
      "langfuse-sync",
      "reconcile-traces",
      "validate-traces",
      "detect-tier",
    ];
    for (const hook of deterministic) {
      expect(HOOK_TIER_MAP[hook]).toBe("deterministic");
    }
  });

  test("agentic tools have correct LLM tiers (in production since PR #8)", () => {
    expect(HOOK_TIER_MAP["query-langfuse-trace"]).toBe("cached_llm");
    expect(HOOK_TIER_MAP["annotate-observation"]).toBe("full_llm");
  });

  test("includes core hooks", () => {
    expect(HOOK_TIER_MAP["langfuse-sync"]).toBe("deterministic");
    expect(HOOK_TIER_MAP["reconcile-traces"]).toBe("deterministic");
    expect(HOOK_TIER_MAP["validate-traces"]).toBe("deterministic");
  });
});

describe("getTier", () => {
  test("returns known hook tier", () => {
    expect(getTier("langfuse-sync")).toBe("deterministic");
  });

  test("returns deterministic as conservative default for unknown hooks", () => {
    expect(getTier("unknown-hook")).toBe("deterministic");
  });
});

describe("TIER_METADATA invariants", () => {
  test("deterministic is non-cacheable with zero cost", () => {
    expect(TIER_METADATA.deterministic.cacheable).toBe(false);
    expect(TIER_METADATA.deterministic.costOrderUSD).toBe(0);
  });

  test("cached_llm is cacheable", () => {
    expect(TIER_METADATA.cached_llm.cacheable).toBe(true);
  });

  test("full_llm is NOT cacheable (output is generative)", () => {
    expect(TIER_METADATA.full_llm.cacheable).toBe(false);
  });

  test("cost increases monotonically with tier heaviness", () => {
    expect(TIER_METADATA.deterministic.costOrderUSD).toBeLessThan(
      TIER_METADATA.cached_llm.costOrderUSD,
    );
    expect(TIER_METADATA.cached_llm.costOrderUSD).toBeLessThan(
      TIER_METADATA.full_llm.costOrderUSD,
    );
  });

  test("latency increases monotonically with tier heaviness", () => {
    expect(TIER_METADATA.deterministic.latencyP99Ms).toBeLessThan(
      TIER_METADATA.cached_llm.latencyP99Ms,
    );
    expect(TIER_METADATA.cached_llm.latencyP99Ms).toBeLessThan(
      TIER_METADATA.full_llm.latencyP99Ms,
    );
  });

  test("non-deterministic tiers require detailed audit", () => {
    expect(TIER_METADATA.deterministic.requiresDetailedAudit).toBe(false);
    expect(TIER_METADATA.cached_llm.requiresDetailedAudit).toBe(true);
    expect(TIER_METADATA.full_llm.requiresDetailedAudit).toBe(true);
  });
});

describe("getTierMetadata", () => {
  test("returns full metadata for known hook", () => {
    const meta = getTierMetadata("langfuse-sync");
    expect(meta).toEqual(TIER_METADATA.deterministic);
  });

  test("defaults to deterministic metadata for unknown hook", () => {
    const meta = getTierMetadata("unknown-hook");
    expect(meta).toEqual(TIER_METADATA.deterministic);
  });
});
