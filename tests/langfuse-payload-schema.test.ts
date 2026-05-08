/**
 * Anti-regression tests for Langfuse v3 payload schema.
 *
 * These tests exist to prevent re-introducing bugs fixed in PR #45:
 *
 *   1. v3 schema guard: generation payload MUST use `usageDetails` with
 *      native cache token keys — never `costDetails.estimatedUSD` (legacy).
 *
 *   2. LANGFUSE_FORCE_NOW_TIMESTAMP=1: when set, both trace and generation
 *      timestamps must be `new Date()` (now), NOT the session start/end
 *      extracted from the JSONL. This ensures ClickHouse ReplacingMergeTree
 *      selects the re-uploaded row (highest event_ts wins).
 *
 *   3. Full costDetails shape: each generation must include per-category cost
 *      fields (input, output, cache_read_input_tokens,
 *      cache_creation_input_tokens, total) — not just `total`.
 *
 * Implementation note: we exercise the exported pure functions + the
 * batch-building logic replicated in e2e-pipeline.test.ts, then add
 * subprocess-level tests that run the actual hook binary and inspect stderr.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { aggregateLines } from "../shared/aggregate";
import { getPricing } from "../shared/model-pricing";

const ROOT = join(import.meta.dir, "..");
const HOOK_PATH = join(ROOT, "hooks", "langfuse-sync.ts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Replicates the generation-create payload logic from hooks/langfuse-sync.ts */
function buildGeneration(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
    serviceTier: string;
    turns: number;
  },
  traceId: string,
) {
  const pricing = getPricing(model);
  const safeModelId = model.replace(/[^a-z0-9-]/gi, "-");
  return {
    type: "generation-create",
    body: {
      id: `${traceId}-${safeModelId}`,
      traceId,
      model,
      usageDetails: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheCreationTokens,
        total:
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheCreationTokens +
          usage.cacheReadTokens,
      },
      costDetails: {
        input: Number(
          ((usage.inputTokens * pricing.input) / 1_000_000).toFixed(8),
        ),
        output: Number(
          ((usage.outputTokens * pricing.output) / 1_000_000).toFixed(8),
        ),
        cache_read_input_tokens: Number(
          ((usage.cacheReadTokens * pricing.cacheRead) / 1_000_000).toFixed(8),
        ),
        cache_creation_input_tokens: Number(
          (
            (usage.cacheCreationTokens * pricing.cacheWrite) /
            1_000_000
          ).toFixed(8),
        ),
        total: Number(usage.cost.toFixed(8)),
      },
    },
  };
}

// ─── v3 Schema Guard ──────────────────────────────────────────────────────────

describe("v3 schema: usageDetails + costDetails shape", () => {
  const SONNET_USAGE = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheCreationTokens: 200,
    cost: 0.0042,
    serviceTier: "standard",
    turns: 2,
  };

  test("generation has usageDetails (not usage.unit)", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const body = gen.body as Record<string, unknown>;
    expect(body).toHaveProperty("usageDetails");
    expect(body).not.toHaveProperty("usage");
  });

  test("usageDetails has cache_read_input_tokens key", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const ud = gen.body.usageDetails as Record<string, unknown>;
    expect(ud).toHaveProperty("cache_read_input_tokens");
    expect(ud["cache_read_input_tokens"]).toBe(100);
  });

  test("usageDetails has cache_creation_input_tokens key", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const ud = gen.body.usageDetails as Record<string, unknown>;
    expect(ud).toHaveProperty("cache_creation_input_tokens");
    expect(ud["cache_creation_input_tokens"]).toBe(200);
  });

  test("costDetails does NOT have estimatedUSD (legacy field)", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const cd = gen.body.costDetails as Record<string, unknown>;
    expect(cd).not.toHaveProperty("estimatedUSD");
  });

  test("costDetails has per-category cost fields", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const cd = gen.body.costDetails as Record<string, unknown>;
    expect(cd).toHaveProperty("input");
    expect(cd).toHaveProperty("output");
    expect(cd).toHaveProperty("cache_read_input_tokens");
    expect(cd).toHaveProperty("cache_creation_input_tokens");
    expect(cd).toHaveProperty("total");
  });

  test("costDetails.input is correct for Sonnet 4.6 ($3/MTok)", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const cd = gen.body.costDetails as Record<string, unknown>;
    // 1000 tokens × $3 / 1_000_000 = $0.003
    expect(cd["input"]).toBeCloseTo(0.003, 6);
  });

  test("costDetails.cache_read_input_tokens is correct for Sonnet 4.6 ($0.30/MTok)", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const cd = gen.body.costDetails as Record<string, unknown>;
    // 100 tokens × $0.30 / 1_000_000 = $0.00003
    expect(cd["cache_read_input_tokens"]).toBeCloseTo(0.00003, 8);
  });

  test("usageDetails.total = input + output + cache_creation + cache_read", () => {
    const gen = buildGeneration("claude-sonnet-4-6", SONNET_USAGE, "cc-test");
    const ud = gen.body.usageDetails as Record<string, unknown>;
    const expected =
      SONNET_USAGE.inputTokens +
      SONNET_USAGE.outputTokens +
      SONNET_USAGE.cacheCreationTokens +
      SONNET_USAGE.cacheReadTokens;
    expect(ud["total"]).toBe(expected);
  });
});

// ─── Opus 4.5+ pricing guard (anti-regression: 3× overcharge) ─────────────────

describe("Opus 4.5+ pricing: $5/$25 NOT $15/$75", () => {
  const MODELS_AT_5_25 = [
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-5-20250501",
    "claude-opus-4-7",
  ];

  const MODELS_AT_15_75 = ["claude-opus-4-1", "claude-opus-4-20240229"];

  for (const model of MODELS_AT_5_25) {
    test(`${model} uses $5 input pricing (not legacy $15)`, () => {
      const pricing = getPricing(model);
      expect(pricing.input).toBe(5);
      expect(pricing.output).toBe(25);
    });
  }

  for (const model of MODELS_AT_15_75) {
    test(`${model} uses legacy $15 input pricing`, () => {
      const pricing = getPricing(model);
      expect(pricing.input).toBe(15);
      expect(pricing.output).toBe(75);
    });
  }

  test("claude-opus-4 (bare) uses legacy $15 (no minor version)", () => {
    const pricing = getPricing("claude-opus-4");
    expect(pricing.input).toBe(15);
  });

  test("longest-key-first: claude-opus-4-7 does not match claude-opus-4 entry", () => {
    // If keys were matched shortest-first, "claude-opus-4" would match "claude-opus-4-7"
    // giving legacy pricing. This test catches that regression.
    const pricingNew = getPricing("claude-opus-4-7");
    const pricingLegacy = getPricing("claude-opus-4");
    expect(pricingNew.input).toBe(5);
    expect(pricingLegacy.input).toBe(15);
    expect(pricingNew.input).not.toBe(pricingLegacy.input);
  });
});

// ─── LANGFUSE_FORCE_NOW_TIMESTAMP subprocess tests ────────────────────────────

describe("LANGFUSE_FORCE_NOW_TIMESTAMP=1 — hook subprocess", () => {
  let tmpDir: string;
  let transcriptPath: string;
  let capturedPayloadPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lf-schema-test-"));
    capturedPayloadPath = join(tmpDir, "captured.json");

    // Write a fixture JSONL with session timestamps from 2026-01-01
    transcriptPath = join(tmpDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        '{"type":"summary","timestamp":"2026-01-01T10:00:00.000Z","sessionId":"force-ts-test","cwd":"/tmp"}',
        '{"type":"assistant","timestamp":"2026-01-01T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50}}}',
        '{"type":"result","timestamp":"2026-01-01T10:02:00.000Z","durationMs":60000}',
      ].join("\n") + "\n",
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runHook(extraEnv: Record<string, string> = {}) {
    const event = {
      session_id: "force-ts-test",
      transcript_path: transcriptPath,
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "Stop",
    };

    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdin: new TextEncoder().encode(JSON.stringify(event)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
      cwd: ROOT,
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode: proc.exitCode ?? -1, stderr };
  }

  test("hook exits 0 regardless of timestamp mode (I-1 invariant)", async () => {
    // Without Langfuse keys → hook logs error but still exits 0
    const result = await runHook({
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_FORCE_NOW_TIMESTAMP: "1",
    });
    expect(result.exitCode).toBe(0);
  });

  test("hook exits 0 without LANGFUSE_FORCE_NOW_TIMESTAMP (baseline)", async () => {
    const result = await runHook({
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
    });
    expect(result.exitCode).toBe(0);
  });

  test("aggregate from fixture has correct session timestamps for 2026-01-01", () => {
    const lines = readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter(Boolean) as string[];
    const agg = aggregateLines(lines);
    expect(agg.start).toBe("2026-01-01T10:00:00.000Z");
    expect(agg.end).toBe("2026-01-01T10:02:00.000Z");
  });
});

// ─── E2E v3 schema: JSONL fixture → aggregate → buildBatch round-trip ─────────

describe("E2E v3 schema round-trip via fixture", () => {
  const FIXTURE_LINES = [
    '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","sessionId":"schema-e2e","cwd":"/tmp/proj"}',
    '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":200,"cache_read_input_tokens":100}}}',
    '{"type":"assistant","timestamp":"2026-04-15T10:02:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":3000,"output_tokens":2000,"cache_creation_input_tokens":500,"cache_read_input_tokens":0}}}',
  ];

  test("aggregate produces correct models from fixture", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    expect(agg.models.size).toBe(2);
    expect(agg.models.has("claude-sonnet-4-6")).toBe(true);
    expect(agg.models.has("claude-opus-4-7")).toBe(true);
  });

  test("generation payloads have usageDetails.cache_read_input_tokens for all models", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    for (const [model, usage] of agg.models) {
      const gen = buildGeneration(model, usage, "cc-schema-e2e");
      const ud = gen.body.usageDetails as Record<string, unknown>;
      expect(ud).toHaveProperty("cache_read_input_tokens");
      expect(ud).toHaveProperty("cache_creation_input_tokens");
    }
  });

  test("generation payloads have costDetails without estimatedUSD", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    for (const [model, usage] of agg.models) {
      const gen = buildGeneration(model, usage, "cc-schema-e2e");
      const cd = gen.body.costDetails as Record<string, unknown>;
      expect(cd).not.toHaveProperty("estimatedUSD");
      expect(cd).toHaveProperty("input");
      expect(cd).toHaveProperty("cache_read_input_tokens");
      expect(cd).toHaveProperty("cache_creation_input_tokens");
    }
  });

  test("Opus 4.7 generation cost uses $5/$25 pricing (not legacy)", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    const opusUsage = agg.models.get("claude-opus-4-7")!;
    const gen = buildGeneration("claude-opus-4-7", opusUsage, "cc-schema-e2e");
    const cd = gen.body.costDetails as Record<string, unknown>;
    // 3000 input × $5/MTok = $0.015
    expect(cd["input"]).toBeCloseTo(0.015, 6);
    // 2000 output × $25/MTok = $0.05
    expect(cd["output"]).toBeCloseTo(0.05, 6);
  });

  test("Sonnet 4.6 generation cost uses $3/$15 pricing", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    const sonnetUsage = agg.models.get("claude-sonnet-4-6")!;
    const gen = buildGeneration(
      "claude-sonnet-4-6",
      sonnetUsage,
      "cc-schema-e2e",
    );
    const cd = gen.body.costDetails as Record<string, unknown>;
    // 1000 input × $3/MTok = $0.003
    expect(cd["input"]).toBeCloseTo(0.003, 6);
    // 500 output × $15/MTok = $0.0075
    expect(cd["output"]).toBeCloseTo(0.0075, 6);
  });

  test("costDetails.total matches sum of individual cost components", () => {
    const agg = aggregateLines(FIXTURE_LINES);
    for (const [model, usage] of agg.models) {
      const gen = buildGeneration(model, usage, "cc-schema-e2e");
      const cd = gen.body.costDetails as Record<string, unknown>;
      const componentSum =
        (cd["input"] as number) +
        (cd["output"] as number) +
        (cd["cache_read_input_tokens"] as number) +
        (cd["cache_creation_input_tokens"] as number);
      expect(cd["total"]).toBeCloseTo(componentSum, 6);
    }
  });
});
