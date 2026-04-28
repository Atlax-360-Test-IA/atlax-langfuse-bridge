import { describe, expect, test, spyOn, beforeEach } from "bun:test";
import { dispatch } from "./mcp-server";
import type { JsonRpcResponse } from "./mcp-server";

const writes: string[] = [];

beforeEach(() => {
  writes.length = 0;
  spyOn(process.stdout, "write").mockImplementation(
    (s: string | Uint8Array) => {
      writes.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    },
  );
});

function lastResponse(): JsonRpcResponse {
  expect(writes.length).toBeGreaterThan(0);
  return JSON.parse(writes[writes.length - 1]!) as JsonRpcResponse;
}

// ─── initialize ─────────────────────────────────────────────────────────────

describe("initialize", () => {
  test("returns protocolVersion + capabilities + serverInfo", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const res = lastResponse();
    expect(res.id).toBe(1);
    const r = res.result as Record<string, unknown>;
    expect(r["protocolVersion"]).toBe("2024-11-05");
    expect(r["capabilities"]).toBeDefined();
    expect((r["serverInfo"] as any).name).toBe("atlax-langfuse-bridge");
  });
});

// ─── tools/list — I-10: MCP_AGENT_TYPE validated against allowlist ────────────

describe("tools/list (I-10)", () => {
  test("returns tools authorized for default agent (coordinator)", async () => {
    await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = lastResponse();
    const tools = (res.result as any).tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("query-langfuse-trace");
    expect(names).toContain("annotate-observation");
  });

  test("each tool exposes a JSON Schema inputSchema", async () => {
    await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const res = lastResponse();
    const tools = (res.result as any).tools as Array<any>;
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });
});

// ─── tools/call ─────────────────────────────────────────────────────────────

describe("tools/call — error handling", () => {
  test("rejects unknown tool with -32601", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    const res = lastResponse();
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("nonexistent");
  });

  test("rejects missing 'name' with -32602", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {},
    });
    const res = lastResponse();
    expect(res.error?.code).toBe(-32602);
  });

  test("rejects invalid arguments via tool.validate", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "annotate-observation",
        arguments: { traceId: "" }, // missing name + value
      },
    });
    const res = lastResponse();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("annotate-observation");
  });

  test("non-object params rejected", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: "not-an-object",
    });
    const res = lastResponse();
    expect(res.error?.code).toBe(-32602);
  });
});

// ─── unknown method ─────────────────────────────────────────────────────────

describe("unknown method", () => {
  test("returns -32601 for non-existent method", async () => {
    await dispatch({ jsonrpc: "2.0", id: 8, method: "completely/unknown" });
    const res = lastResponse();
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("Method not found");
  });

  test("notifications (no id) silently ignored", async () => {
    writes.length = 0;
    await dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as any);
    expect(writes).toHaveLength(0);
  });
});

// ─── ping ───────────────────────────────────────────────────────────────────

describe("ping", () => {
  test("responds with empty result", async () => {
    await dispatch({ jsonrpc: "2.0", id: 9, method: "ping" });
    const res = lastResponse();
    expect(res.id).toBe(9);
    expect(res.result).toEqual({});
  });
});

// ─── sandbox integration ────────────────────────────────────────────────────

describe("sandbox echo via env", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    process.env["LANGFUSE_BRIDGE_SANDBOX_MODE"] = "echo";
  });
  // afterEach restores via outer beforeEach reset of writes; restore env explicitly
  test("tools/call returns echo response without hitting Langfuse", async () => {
    await dispatch({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "query-langfuse-trace",
        arguments: { traceId: "cc-fake-123" },
      },
    });
    const res = lastResponse();
    expect(res.error).toBeUndefined();
    const result = res.result as any;
    expect(result.isError).toBe(false);
    const text = JSON.parse(result.content[0].text);
    expect(text.__sandbox).toBe("echo");
    expect(text.input).toEqual({ traceId: "cc-fake-123" });
    process.env = { ...origEnv };
  });
});
