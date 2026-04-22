import { describe, expect, test } from "bun:test";
import { aggregateLines } from "./aggregate";

// ─── Fixture lines (matches tests/fixtures/session.jsonl) ───────────────────

const FIXTURE_LINES = [
  '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","sessionId":"test-abc-123","cwd":"/home/dev/work/my-project","entrypoint":"cli","gitBranch":"feat/cool-feature"}',
  '{"type":"user","timestamp":"2026-04-15T10:00:05.000Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":200,"cache_read_input_tokens":100,"service_tier":"standard"}}}',
  '{"type":"user","timestamp":"2026-04-15T10:02:00.000Z","message":{"role":"user","content":"refactor this"}}',
  '{"type":"assistant","timestamp":"2026-04-15T10:03:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":2000,"output_tokens":1500,"cache_creation_input_tokens":0,"cache_read_input_tokens":500,"service_tier":"standard"}}}',
  '{"type":"user","timestamp":"2026-04-15T10:04:00.000Z","message":{"role":"user","content":"switch to opus"}}',
  '{"type":"assistant","timestamp":"2026-04-15T10:05:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","stop_reason":"end_turn","usage":{"input_tokens":3000,"output_tokens":2000,"cache_creation_input_tokens":500,"cache_read_input_tokens":0,"service_tier":"priority"}}}',
  '{"type":"result","timestamp":"2026-04-15T10:06:00.000Z","durationMs":360000}',
];

describe("aggregateLines", () => {
  test("counts only assistant turns with usage", () => {
    const result = aggregateLines(FIXTURE_LINES);
    expect(result.turns).toBe(3);
  });

  test("extracts session timestamps from first and last entry", () => {
    const result = aggregateLines(FIXTURE_LINES);
    expect(result.start).toBe("2026-04-15T10:00:00.000Z");
    expect(result.end).toBe("2026-04-15T10:06:00.000Z");
  });

  test("extracts cwd from first entry that has one", () => {
    const result = aggregateLines(FIXTURE_LINES);
    expect(result.cwd).toBe("/home/dev/work/my-project");
  });

  test("aggregates per-model metrics", () => {
    const result = aggregateLines(FIXTURE_LINES);
    expect(result.models.size).toBe(2);

    const sonnet = result.models.get("claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.turns).toBe(2);
    expect(sonnet!.inputTokens).toBe(3000); // 1000 + 2000
    expect(sonnet!.outputTokens).toBe(2000); // 500 + 1500
    expect(sonnet!.cacheCreationTokens).toBe(200);
    expect(sonnet!.cacheReadTokens).toBe(600); // 100 + 500

    const opus = result.models.get("claude-opus-4-7");
    expect(opus).toBeDefined();
    expect(opus!.turns).toBe(1);
    expect(opus!.inputTokens).toBe(3000);
    expect(opus!.outputTokens).toBe(2000);
  });

  test("computes total cost using model pricing", () => {
    const result = aggregateLines(FIXTURE_LINES);
    // Sonnet turn 1: (1000*3 + 200*3.75 + 100*0.3 + 500*15) / 1M
    //              = (3000 + 750 + 30 + 7500) / 1M = 0.01128
    // Sonnet turn 2: (2000*3 + 0*3.75 + 500*0.3 + 1500*15) / 1M
    //              = (6000 + 0 + 150 + 22500) / 1M = 0.02865
    // Opus turn:     (3000*15 + 500*18.75 + 0*1.5 + 2000*75) / 1M
    //              = (45000 + 9375 + 0 + 150000) / 1M = 0.204375
    expect(result.totalCost).toBeCloseTo(0.01128 + 0.02865 + 0.204375, 5);
  });

  test("handles empty lines gracefully", () => {
    const result = aggregateLines([]);
    expect(result.turns).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.start).toBeUndefined();
    expect(result.end).toBeUndefined();
    expect(result.cwd).toBeUndefined();
    expect(result.models.size).toBe(0);
  });

  test("skips malformed JSON lines", () => {
    const lines = [
      "not json at all",
      '{"type":"assistant","timestamp":"2026-04-15T10:00:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50}}}',
      "also {broken json",
    ];
    const result = aggregateLines(lines);
    expect(result.turns).toBe(1);
  });

  test("skips assistant entries without usage", () => {
    const lines = [
      '{"type":"assistant","timestamp":"2026-04-15T10:00:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6"}}',
      '{"type":"assistant","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50}}}',
    ];
    const result = aggregateLines(lines);
    expect(result.turns).toBe(1);
  });

  test("uses 'unknown' model for entries without model field", () => {
    const lines = [
      '{"type":"assistant","timestamp":"2026-04-15T10:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50}}}',
    ];
    const result = aggregateLines(lines);
    expect(result.models.has("unknown")).toBe(true);
  });

  test("cwd comes from first entry only, not overwritten", () => {
    const lines = [
      '{"type":"summary","timestamp":"2026-04-15T10:00:00.000Z","cwd":"/first/path"}',
      '{"type":"summary","timestamp":"2026-04-15T10:01:00.000Z","cwd":"/second/path"}',
    ];
    const result = aggregateLines(lines);
    expect(result.cwd).toBe("/first/path");
  });
});
