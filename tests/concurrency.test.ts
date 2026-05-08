/**
 * Concurrency / stress tests — verify that critical pieces with shared state
 * serialize correctly under load. These tests address gap Q9 of the post-v1
 * audit (no concurrency tests existed for sandbox.ts mutex despite 100% line
 * coverage by happy-path tests).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  withSandbox,
  clearExecutionQueue,
  registerFixture,
  clearFixtures,
} from "../shared/tools/sandbox";
import type { AgentTool, ToolContext } from "../shared/tools/types";

const ctx: ToolContext = { agentType: "coordinator", stepBudgetMs: 5000 };

beforeEach(() => {
  clearExecutionQueue();
  clearFixtures();
});

describe("withSandbox mutex — concurrent execute() calls", () => {
  test("serializes N=10 concurrent execute() calls — no overlapping execution", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tool: AgentTool<{ id: number }, { id: number; ts: number }> = {
      name: "concurrent-tool-stress",
      description: "stress",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      validate(raw) {
        const r = raw as { id?: unknown };
        if (typeof r.id !== "number") {
          return { ok: false, error: "id must be number" };
        }
        return { ok: true, data: { id: r.id } };
      },
      async execute(input) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield twice to give other concurrent calls a chance to enter,
        // demonstrating the mutex actually serializes (without it,
        // maxInFlight would be N).
        await new Promise((r) => setTimeout(r, 1));
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { id: input.id, ts: Date.now() };
      },
    };

    const wrapped = withSandbox(tool, "off");
    const N = 10;
    const promises = Array.from({ length: N }, (_, i) =>
      wrapped.execute({ id: i }, ctx),
    );
    // In sandbox mode "off" execute returns the raw TOutput, not the
    // sandboxed envelope. The cast is safe and intentional.
    const results = (await Promise.all(promises)) as Array<{
      id: number;
      ts: number;
    }>;

    expect(results).toHaveLength(N);
    // The mutex must guarantee that no two execute() calls overlap.
    expect(maxInFlight).toBe(1);
    // All N calls completed and produced their input back.
    expect(results.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
  });

  test("mutex releases on rejection — subsequent calls do not deadlock", async () => {
    let callCount = 0;
    const tool: AgentTool<{ shouldFail: boolean }, { ok: true }> = {
      name: "concurrent-tool-fail",
      description: "fail",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: { shouldFail: { type: "boolean" } },
        required: ["shouldFail"],
      },
      validate(raw) {
        const r = raw as { shouldFail?: unknown };
        if (typeof r.shouldFail !== "boolean") {
          return { ok: false, error: "shouldFail must be boolean" };
        }
        return { ok: true, data: { shouldFail: r.shouldFail } };
      },
      async execute(input) {
        callCount++;
        if (input.shouldFail) throw new Error("boom");
        return { ok: true };
      },
    };

    const wrapped = withSandbox(tool, "off");
    // First call rejects — must not leave the mutex held.
    await expect(wrapped.execute({ shouldFail: true }, ctx)).rejects.toThrow(
      "boom",
    );
    // Second call after rejection must complete promptly (no deadlock).
    const result = await wrapped.execute({ shouldFail: false }, ctx);
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  test("different tool names do not share the mutex (independent execution)", async () => {
    let toolAInFlight = 0;
    let bothInFlightAtOnce = false;
    const buildTool = (
      suffix: string,
      onEnter: () => void,
      onExit: () => void,
    ): AgentTool<Record<string, never>, { name: string }> => ({
      name: `concurrent-tool-${suffix}`,
      description: "indep",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: { type: "object", properties: {}, required: [] },
      validate() {
        return { ok: true, data: {} };
      },
      async execute() {
        onEnter();
        await new Promise((r) => setTimeout(r, 5));
        onExit();
        return { name: suffix };
      },
    });

    const toolA = buildTool(
      "A",
      () => {
        toolAInFlight++;
      },
      () => {
        toolAInFlight--;
      },
    );
    const toolB = buildTool(
      "B",
      () => {
        if (toolAInFlight > 0) bothInFlightAtOnce = true;
      },
      () => {},
    );

    const wA = withSandbox(toolA, "off");
    const wB = withSandbox(toolB, "off");
    await Promise.all([wA.execute({}, ctx), wB.execute({}, ctx)]);
    // Mutex is per-tool-name — different names should run concurrently.
    expect(bothInFlightAtOnce).toBe(true);
  });
});

describe("MCP server — arg validation hardening", () => {
  test("validate() rejects raw=null gracefully", async () => {
    const { queryLangfuseTrace } =
      await import("../shared/tools/query-langfuse-trace");
    const result = queryLangfuseTrace.validate(null);
    expect(result.ok).toBe(false);
  });

  test("validate() rejects raw with wrong types (defensive)", async () => {
    const { queryLangfuseTrace } =
      await import("../shared/tools/query-langfuse-trace");
    // Trace ID as object — must reject
    const result = queryLangfuseTrace.validate({ traceId: { evil: true } });
    expect(result.ok).toBe(false);
  });

  test("validate() rejects extreme limit values", async () => {
    const { queryLangfuseTrace } =
      await import("../shared/tools/query-langfuse-trace");
    // Negative limit
    expect(queryLangfuseTrace.validate({ limit: -5 }).ok).toBe(false);
    // Limit way above max
    expect(queryLangfuseTrace.validate({ limit: 100_000 }).ok).toBe(false);
    // Non-number
    expect(queryLangfuseTrace.validate({ limit: "20" }).ok).toBe(false);
  });

  test("annotateObservation rejects invalid value types", async () => {
    const { annotateObservation } =
      await import("../shared/tools/annotate-observation");
    // value: object — must reject (only number/string/boolean)
    const result = annotateObservation.validate({
      traceId: "cc-test",
      name: "agent:test",
      value: { unsupported: true },
    });
    expect(result.ok).toBe(false);
  });
});

describe("safeFilePath — path traversal defenses", () => {
  test("blocks ../ escape", async () => {
    const { safeFilePath } = await import("../shared/validation");
    expect(() =>
      safeFilePath("/safe/root", "/safe/root/../etc/passwd"),
    ).toThrow(/escapes safe root/);
  });

  test("blocks sibling-prefix escape (root-suffix trick)", async () => {
    const { safeFilePath } = await import("../shared/validation");
    // /safe/root vs /safe/rootEvil — the test verifies we don't accept
    // /safe/rootEvil/x as inside /safe/root by string-prefix.
    expect(() => safeFilePath("/safe/root", "/safe/rootEvil/x")).toThrow(
      /escapes safe root/,
    );
  });

  test("accepts paths inside the root", async () => {
    const { safeFilePath } = await import("../shared/validation");
    const ok = safeFilePath("/safe/root", "/safe/root/sub/file.txt");
    expect(ok).toBe("/safe/root/sub/file.txt");
  });

  test("rejects empty/non-string input", async () => {
    const { safeFilePath } = await import("../shared/validation");
    expect(() => safeFilePath("/safe/root", "")).toThrow(/non-empty string/);
    expect(() => safeFilePath("/safe/root", null as unknown as string)).toThrow(
      /non-empty string/,
    );
  });
});
