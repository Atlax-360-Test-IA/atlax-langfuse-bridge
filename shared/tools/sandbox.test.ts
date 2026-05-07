import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  getSandboxMode,
  withSandbox,
  withSandboxAll,
  registerFixture,
  clearFixtures,
  clearExecutionQueue,
  type SandboxedExecutionOutput,
} from "./sandbox";
import type { AgentTool, ToolContext } from "./types";

const ctx: ToolContext = { agentType: "coordinator", stepBudgetMs: 5000 };

const realExecute = async () => ({ real: true, value: 42 });

const tool: AgentTool<{ x: number }, { real: boolean; value: number }> = {
  name: "real-tool",
  description: "x",
  tier: "deterministic",
  allowedAgentTypes: ["coordinator"],
  inputSchema: {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  },
  validate: (raw) => {
    const r = raw as { x: number };
    if (typeof r.x !== "number")
      return { ok: false, error: "x must be number" };
    return { ok: true, data: r };
  },
  execute: realExecute,
};

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  clearFixtures();
});

// ─── getSandboxMode ──────────────────────────────────────────────────────────

describe("getSandboxMode", () => {
  test("returns 'off' when env unset", () => {
    delete process.env["LANGFUSE_BRIDGE_SANDBOX_MODE"];
    expect(getSandboxMode()).toBe("off");
  });

  test("returns valid modes verbatim", () => {
    expect(
      getSandboxMode({ LANGFUSE_BRIDGE_SANDBOX_MODE: "echo" } as any),
    ).toBe("echo");
    expect(
      getSandboxMode({ LANGFUSE_BRIDGE_SANDBOX_MODE: "fixture" } as any),
    ).toBe("fixture");
    expect(
      getSandboxMode({ LANGFUSE_BRIDGE_SANDBOX_MODE: "degradation" } as any),
    ).toBe("degradation");
  });

  test("falls back to 'off' for unknown values (fail-safe)", () => {
    expect(
      getSandboxMode({ LANGFUSE_BRIDGE_SANDBOX_MODE: "nuclear" } as any),
    ).toBe("off");
  });
});

// ─── withSandbox(off) ────────────────────────────────────────────────────────

describe("withSandbox — off mode", () => {
  afterEach(() => clearExecutionQueue());

  test("preserves tool name, description and schema", () => {
    const wrapped = withSandbox(tool, "off");
    expect(wrapped.name).toBe(tool.name);
    expect(wrapped.description).toBe(tool.description);
    expect(wrapped.inputSchema).toBe(tool.inputSchema);
  });

  test("calls real execute", async () => {
    const wrapped = withSandbox(tool, "off");
    const out = await wrapped.execute({ x: 1 }, ctx);
    expect(out).toEqual({ real: true, value: 42 });
  });

  test("serializes concurrent executions (mutex)", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const blocking: AgentTool<any, any> = {
      ...tool,
      execute: async (input: { seq: number }) => {
        order.push(input.seq);
        if (input.seq === 1) {
          await new Promise<void>((r) => {
            resolve1 = r;
          });
        }
        return {};
      },
    };
    const wrapped = withSandbox(blocking, "off");
    const p1 = wrapped.execute({ seq: 1 }, ctx);
    const p2 = wrapped.execute({ seq: 2 }, ctx);
    // Let the event loop run p1's execute start
    await new Promise((r) => setTimeout(r, 0));
    resolve1();
    await Promise.all([p1, p2]);
    // p2 must start AFTER p1 finishes — order must be [1, 2]
    expect(order).toEqual([1, 2]);
  });
});

// ─── echo mode ───────────────────────────────────────────────────────────────

describe("withSandbox — echo mode", () => {
  test("does NOT call the real execute", async () => {
    let realCalled = false;
    const spied: AgentTool<any, any> = {
      ...tool,
      execute: async () => {
        realCalled = true;
        return {};
      },
    };
    const wrapped = withSandbox(spied, "echo");
    await wrapped.execute({ x: 1 }, ctx);
    expect(realCalled).toBe(false);
  });

  test("returns __sandbox=echo with input", async () => {
    const wrapped = withSandbox(tool, "echo");
    const out = (await wrapped.execute(
      { x: 99 },
      ctx,
    )) as SandboxedExecutionOutput;
    expect(out.__sandbox).toBe("echo");
    expect(out.input).toEqual({ x: 99 });
  });

  test("preserves name/description/tier of wrapped tool", () => {
    const wrapped = withSandbox(tool, "echo");
    expect(wrapped.name).toBe("real-tool");
    expect(wrapped.tier).toBe("deterministic");
  });

  test("preserves validate behavior", () => {
    const wrapped = withSandbox(tool, "echo");
    expect(wrapped.validate({ x: 5 }).ok).toBe(true);
    expect(wrapped.validate({ x: "no" }).ok).toBe(false);
  });
});

// ─── fixture mode ───────────────────────────────────────────────────────────

describe("withSandbox — fixture mode", () => {
  test("returns registered fixture", async () => {
    registerFixture("real-tool", { canned: "response", count: 7 });
    const wrapped = withSandbox(tool, "fixture");
    const out = (await wrapped.execute(
      { x: 1 },
      ctx,
    )) as SandboxedExecutionOutput;
    expect(out.__sandbox).toBe("fixture");
    expect(out.fixture).toEqual({ canned: "response", count: 7 });
  });

  test("throws when no fixture registered", async () => {
    const wrapped = withSandbox(tool, "fixture");
    let err: Error | null = null;
    try {
      await wrapped.execute({ x: 1 }, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("real-tool");
    expect(err!.message).toContain("no fixture registered");
  });
});

// ─── degradation mode ───────────────────────────────────────────────────────

describe("withSandbox — degradation mode", () => {
  test("returns __sandbox=degradation with degradation entries", async () => {
    const wrapped = withSandbox(tool, "degradation");
    const out = (await wrapped.execute(
      { x: 1 },
      ctx,
    )) as SandboxedExecutionOutput;
    expect(out.__sandbox).toBe("degradation");
    expect(out.degradation).toHaveLength(1);
    expect(out.degradation![0]!.severity).toBe("medium");
    expect(out.degradation![0]!.reason).toBe("sandbox-degradation-mode");
  });
});

// ─── env-driven activation ──────────────────────────────────────────────────

describe("env-driven activation (no override)", () => {
  test("uses env when modeOverride omitted", async () => {
    process.env["LANGFUSE_BRIDGE_SANDBOX_MODE"] = "echo";
    const wrapped = withSandbox(tool); // no override
    const out = (await wrapped.execute(
      { x: 7 },
      ctx,
    )) as SandboxedExecutionOutput;
    expect(out.__sandbox).toBe("echo");
  });

  test("env=off behaves like passthrough", async () => {
    delete process.env["LANGFUSE_BRIDGE_SANDBOX_MODE"];
    const wrapped = withSandbox(tool);
    const out = await wrapped.execute({ x: 7 }, ctx);
    expect((out as any).real).toBe(true);
  });
});

// ─── withSandboxAll ─────────────────────────────────────────────────────────

describe("withSandboxAll", () => {
  test("wraps each tool in the array", async () => {
    const tools = [
      { ...tool, name: "a" } as AgentTool<any, any>,
      { ...tool, name: "b" } as AgentTool<any, any>,
    ];
    const wrapped = withSandboxAll(tools, "echo");
    expect(wrapped).toHaveLength(2);
    const out = (await wrapped[0]!.execute(
      { x: 1 },
      ctx,
    )) as SandboxedExecutionOutput;
    expect(out.__sandbox).toBe("echo");
  });
});
