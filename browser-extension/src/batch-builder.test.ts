/**
 * Tests for browser-extension/src/batch-builder.js
 *
 * Pure unit tests — no chrome.* dependencies.
 * Covers the Langfuse batch structure built per assistant turn.
 */

import { describe, expect, test } from "bun:test";
import { buildTurnBatch } from "./batch-builder.js";

const BASE_TURN = {
  model: "claude-sonnet-4-6",
  inputTokens: 1000,
  outputTokens: 500,
  surface: "chat",
  platform: "browser",
  conversationId: "550e8400-e29b-41d4-a716-446655440000",
  url: "https://claude.ai/chat/test",
  timestamp: "2026-04-27T10:00:00.000Z",
};

describe("buildTurnBatch", () => {
  test("returns array with trace-create and generation-create", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    expect(batch).toHaveLength(2);
    expect(batch.find((e) => e.type === "trace-create")).toBeDefined();
    expect(batch.find((e) => e.type === "generation-create")).toBeDefined();
  });

  test("trace-create body has correct traceId from conversationId", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    const trace = batch.find((e) => e.type === "trace-create")!;
    const body = trace.body as Record<string, unknown>;
    expect(body["id"]).toBe(`claude-web-${BASE_TURN.conversationId}`);
    expect(body["name"]).toBe("claude-ai-session");
    expect(body["userId"]).toBe("user@atlax360.com");
    expect(body["sessionId"]).toBe(BASE_TURN.conversationId);
  });

  test("trace-create tags include surface, platform, entrypoint, tier", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    const trace = batch.find((e) => e.type === "trace-create")!;
    const tags = (trace.body as Record<string, unknown>)["tags"] as string[];
    expect(tags).toContain("surface:chat");
    expect(tags).toContain("platform:browser");
    expect(tags).toContain("entrypoint:claude-ai");
    expect(tags).toContain("tier:claude-web");
    expect(tags).toContain("tier-source:browser-extension");
  });

  test("platform:app maps to tier:claude-app", () => {
    const batch = buildTurnBatch({ ...BASE_TURN, platform: "app" }, "u@x.com");
    const trace = batch.find((e) => e.type === "trace-create")!;
    const tags = (trace.body as Record<string, unknown>)["tags"] as string[];
    expect(tags).toContain("tier:claude-app");
  });

  test("generation-create links to correct traceId", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    const gen = batch.find((e) => e.type === "generation-create")!;
    const body = gen.body as Record<string, unknown>;
    expect(body["traceId"]).toBe(`claude-web-${BASE_TURN.conversationId}`);
    expect(body["model"]).toBe(BASE_TURN.model);
  });

  test("generation-create usage has correct token counts", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    const gen = batch.find((e) => e.type === "generation-create")!;
    const body = gen.body as Record<string, unknown>;
    const usage = body["usage"] as Record<string, unknown>;
    expect(usage["input"]).toBe(1000);
    expect(usage["output"]).toBe(500);
    expect(usage["unit"]).toBe("TOKENS");
  });

  test("generation-create costDetails is non-negative number", () => {
    const batch = buildTurnBatch(BASE_TURN, "user@atlax360.com");
    const gen = batch.find((e) => e.type === "generation-create")!;
    const body = gen.body as Record<string, unknown>;
    const costDetails = body["costDetails"] as Record<string, unknown>;
    expect(typeof costDetails["estimatedUSD"]).toBe("number");
    expect((costDetails["estimatedUSD"] as number) >= 0).toBe(true);
  });

  test("null conversationId generates a random UUID for traceId", () => {
    const batch = buildTurnBatch(
      { ...BASE_TURN, conversationId: null },
      "u@x.com",
    );
    const trace = batch.find((e) => e.type === "trace-create")!;
    const body = trace.body as Record<string, unknown>;
    expect(typeof body["id"]).toBe("string");
    expect((body["id"] as string).startsWith("claude-web-")).toBe(true);
  });

  test("null model defaults to 'claude-web' and 'unknown'", () => {
    const batch = buildTurnBatch({ ...BASE_TURN, model: null }, "u@x.com");
    const gen = batch.find((e) => e.type === "generation-create")!;
    const body = gen.body as Record<string, unknown>;
    expect(body["name"]).toBe("claude-web");
    expect(body["model"]).toBe("unknown");
  });

  test("null timestamp defaults to a valid ISO string", () => {
    const batch = buildTurnBatch({ ...BASE_TURN, timestamp: null }, "u@x.com");
    const trace = batch.find((e) => e.type === "trace-create")!;
    expect(typeof trace.timestamp).toBe("string");
    expect(() => new Date(trace.timestamp as string)).not.toThrow();
  });

  test("each call generates unique UUIDs for event ids", () => {
    const a = buildTurnBatch(BASE_TURN, "u@x.com");
    const b = buildTurnBatch(BASE_TURN, "u@x.com");
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(a[1]!.id).not.toBe(b[1]!.id);
  });
});
