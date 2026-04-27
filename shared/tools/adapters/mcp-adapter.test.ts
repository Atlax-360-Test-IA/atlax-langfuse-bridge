import { describe, expect, test } from "bun:test";
import { toMcpTool, toMcpToolset } from "./mcp-adapter";
import type { AgentTool } from "../types";

const sampleTool: AgentTool = {
  name: "sample-tool",
  description: "Sample for tests",
  tier: "deterministic",
  allowedAgentTypes: ["coordinator"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "ID" },
      tags: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["a", "b", "c"] as const },
      count: { type: "number" },
    },
    required: ["id"],
  },
  validate: (raw) => ({ ok: true, data: raw }),
  execute: async () => ({}),
};

describe("toMcpTool", () => {
  test("preserves name and description", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.name).toBe("sample-tool");
    expect(desc.description).toBe("Sample for tests");
  });

  test("inputSchema is a JSON Schema object with type=object", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.inputSchema.type).toBe("object");
    expect(desc.inputSchema.additionalProperties).toBe(false);
  });

  test("required array preserved as a list of strings", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.inputSchema.required).toEqual(["id"]);
  });

  test("required defaults to [] when omitted", () => {
    const noReq: AgentTool = {
      ...sampleTool,
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    };
    const desc = toMcpTool(noReq);
    expect(desc.inputSchema.required).toEqual([]);
  });

  test("string with enum preserved", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.inputSchema.properties["mode"]!.enum).toEqual(["a", "b", "c"]);
  });

  test("array property maps items recursively", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.inputSchema.properties["tags"]!.type).toBe("array");
    expect(desc.inputSchema.properties["tags"]!.items!.type).toBe("string");
  });

  test("description on properties is preserved", () => {
    const desc = toMcpTool(sampleTool);
    expect(desc.inputSchema.properties["id"]!.description).toBe("ID");
  });
});

describe("toMcpToolset", () => {
  test("maps a list", () => {
    const set = toMcpToolset([sampleTool, { ...sampleTool, name: "other" }]);
    expect(set).toHaveLength(2);
    expect(set.map((t) => t.name).sort()).toEqual(["other", "sample-tool"]);
  });
});
