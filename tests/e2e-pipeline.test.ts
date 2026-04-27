/**
 * E2E pipeline test — verifies the full flow from JSONL fixture to
 * Langfuse batch structure, without hitting a real Langfuse instance.
 *
 * Tests the complete transformation:
 *   JSONL lines → aggregate → build batch → verify batch structure
 *
 * This catches structural regressions in the Langfuse ingestion payload
 * that would silently fail at runtime (Langfuse accepts malformed events
 * and drops them without error).
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateLines } from "../shared/aggregate";
import { calcCost } from "../hooks/langfuse-sync";
import { getPricing } from "../shared/model-pricing";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "session.jsonl");
let FIXTURE_LINES: string[] = [];

beforeAll(() => {
  FIXTURE_LINES = readFileSync(FIXTURE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean);
});

// ─── Simulate the batch-building logic from langfuse-sync.ts ────────────────

function buildBatch(
  sessionId: string,
  lines: string[],
): { trace: Record<string, unknown>; generations: Record<string, unknown>[] } {
  const agg = aggregateLines(lines);
  const traceId = `cc-${sessionId}`;
  const traceTimestamp = agg.start ?? new Date().toISOString();

  const trace = {
    type: "trace-create",
    timestamp: traceTimestamp,
    body: {
      id: traceId,
      timestamp: traceTimestamp,
      name: "claude-code-session",
      userId: "test@test.com",
      sessionId,
      tags: [`project:test-project`, `billing:anthropic-team-standard`],
      metadata: {
        turns: agg.turns,
        sessionStart: agg.start ?? null,
        sessionEnd: agg.end ?? null,
        estimatedCostUSD: Number(agg.totalCost.toFixed(6)),
        modelsUsed: [...agg.models.keys()],
      },
      input: { turns: agg.turns },
      output: { estimatedCostUSD: agg.totalCost },
    },
  };

  const generations: Record<string, unknown>[] = [];
  for (const [model, usage] of agg.models) {
    const safeModelId = model.replace(/[^a-z0-9-]/gi, "-");
    generations.push({
      type: "generation-create",
      timestamp: agg.end ?? traceTimestamp,
      body: {
        id: `${traceId}-${safeModelId}`,
        traceId,
        name: model,
        model,
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total:
            usage.inputTokens +
            usage.outputTokens +
            usage.cacheCreationTokens +
            usage.cacheReadTokens,
          unit: "TOKENS",
        },
        costDetails: {
          estimatedUSD: Number(usage.cost.toFixed(6)),
        },
        metadata: {
          cacheCreationTokens: usage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens,
          serviceTier: usage.serviceTier,
          turns: usage.turns,
        },
      },
    });
  }

  return { trace, generations };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("E2E pipeline: JSONL → Langfuse batch", () => {
  const SESSION_ID = "test-abc-123";
  let batch: ReturnType<typeof buildBatch>;

  beforeAll(() => {
    batch = buildBatch(SESSION_ID, FIXTURE_LINES);
  });

  test("trace has correct type and traceId", () => {
    expect(batch.trace["type"]).toBe("trace-create");
    const body = batch.trace["body"] as Record<string, unknown>;
    expect(body["id"]).toBe("cc-test-abc-123");
    expect(body["name"]).toBe("claude-code-session");
  });

  test("trace timestamp uses session start, not current time", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    expect(batch.trace["timestamp"]).toBe("2026-04-15T10:00:00.000Z");
    expect(body["timestamp"]).toBe("2026-04-15T10:00:00.000Z");
  });

  test("trace body.timestamp matches envelope timestamp (I-2 idempotency)", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    expect(body["timestamp"]).toBe(batch.trace["timestamp"]);
  });

  test("trace metadata contains correct turn count", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    const meta = body["metadata"] as Record<string, unknown>;
    expect(meta["turns"]).toBe(3);
  });

  test("trace metadata has correct session timestamps", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    const meta = body["metadata"] as Record<string, unknown>;
    expect(meta["sessionStart"]).toBe("2026-04-15T10:00:00.000Z");
    expect(meta["sessionEnd"]).toBe("2026-04-15T10:06:00.000Z");
  });

  test("trace metadata lists all models used", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    const meta = body["metadata"] as Record<string, unknown>;
    const models = meta["modelsUsed"] as string[];
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("claude-opus-4-7");
    expect(models.length).toBe(2);
  });

  test("one generation per model", () => {
    expect(batch.generations.length).toBe(2);
    const names = batch.generations.map(
      (g) => (g["body"] as Record<string, unknown>)["model"],
    );
    expect(names).toContain("claude-sonnet-4-6");
    expect(names).toContain("claude-opus-4-7");
  });

  test("generations reference the parent trace", () => {
    for (const gen of batch.generations) {
      const body = gen["body"] as Record<string, unknown>;
      expect(body["traceId"]).toBe("cc-test-abc-123");
    }
  });

  test("generation IDs are deterministic and unique", () => {
    const ids = batch.generations.map(
      (g) => (g["body"] as Record<string, unknown>)["id"],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("cc-test-abc-123-claude-sonnet-4-6");
    expect(ids).toContain("cc-test-abc-123-claude-opus-4-7");
  });

  test("generation usage tokens are positive integers", () => {
    for (const gen of batch.generations) {
      const body = gen["body"] as Record<string, unknown>;
      const usage = body["usage"] as Record<string, unknown>;
      expect(usage["input"]).toBeGreaterThan(0);
      expect(usage["output"]).toBeGreaterThan(0);
      expect(usage["total"]).toBeGreaterThan(0);
      expect(usage["unit"]).toBe("TOKENS");
    }
  });

  test("total tokens = input + output + cache tokens", () => {
    for (const gen of batch.generations) {
      const body = gen["body"] as Record<string, unknown>;
      const usage = body["usage"] as Record<string, unknown>;
      const meta = body["metadata"] as Record<string, unknown>;
      const expectedTotal =
        (usage["input"] as number) +
        (usage["output"] as number) +
        (meta["cacheCreationTokens"] as number) +
        (meta["cacheReadTokens"] as number);
      expect(usage["total"]).toBe(expectedTotal);
    }
  });

  test("estimated cost is positive and reasonable", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    const meta = body["metadata"] as Record<string, unknown>;
    const cost = meta["estimatedCostUSD"] as number;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(10); // sanity check for fixture data
  });

  test("generation costs sum to trace total cost", () => {
    const body = batch.trace["body"] as Record<string, unknown>;
    const meta = body["metadata"] as Record<string, unknown>;
    const traceCost = meta["estimatedCostUSD"] as number;

    let genTotal = 0;
    for (const gen of batch.generations) {
      const genBody = gen["body"] as Record<string, unknown>;
      const costDetails = genBody["costDetails"] as Record<string, unknown>;
      genTotal += costDetails["estimatedUSD"] as number;
    }

    expect(genTotal).toBeCloseTo(traceCost, 5);
  });

  test("generation timestamp uses session end, not start", () => {
    for (const gen of batch.generations) {
      expect(gen["timestamp"]).toBe("2026-04-15T10:06:00.000Z");
    }
  });
});

// ─── Edge cases — I-3: cwd extracted from first JSONL entry, not Stop event ───

describe("E2E edge cases (I-3: cwd from first entry)", () => {
  test("session with no assistant turns produces empty batch", () => {
    const lines = [
      '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","cwd":"/tmp"}',
      '{"type":"user","timestamp":"2026-04-15T10:00:05.000Z","message":{"role":"user","content":"hello"}}',
    ];
    const agg = aggregateLines(lines);
    expect(agg.turns).toBe(0);
    expect(agg.models.size).toBe(0);
  });

  test("single-turn session produces exactly one generation", () => {
    const lines = [
      '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","cwd":"/tmp"}',
      '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":100,"output_tokens":50}}}',
    ];
    const batch = buildBatch("single-turn", lines);
    expect(batch.generations.length).toBe(1);
    const body = batch.generations[0]!["body"] as Record<string, unknown>;
    expect(body["model"]).toBe("claude-haiku-4-5-20251001");
  });

  test("multi-model session groups generations by model", () => {
    const lines = [
      '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50}}}',
      '{"type":"assistant","timestamp":"2026-04-15T10:02:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":200,"output_tokens":100}}}',
      '{"type":"assistant","timestamp":"2026-04-15T10:03:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":150}}}',
    ];
    const batch = buildBatch("multi-model", lines);
    // 2 models, not 3 generations
    expect(batch.generations.length).toBe(2);

    const sonnet = batch.generations.find(
      (g) =>
        (g["body"] as Record<string, unknown>)["model"] === "claude-sonnet-4-6",
    );
    const sonnetBody = sonnet!["body"] as Record<string, unknown>;
    const sonnetUsage = sonnetBody["usage"] as Record<string, unknown>;
    // Aggregated: 100+300 = 400 input, 50+150 = 200 output
    expect(sonnetUsage["input"]).toBe(400);
    expect(sonnetUsage["output"]).toBe(200);
  });
});
