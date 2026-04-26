import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { AgentTool, ToolContext } from "../types";

// ─── Fake Zod to mock dynamic import ─────────────────────────────────────────

const fakeZ = {
  object: mock((shape: Record<string, unknown>) => ({ kind: "object", shape })),
  string: mock(() => ({
    kind: "string",
    optional: () => ({ kind: "optional-string" }),
  })),
  number: mock(() => ({
    kind: "number",
    optional: () => ({ kind: "optional-number" }),
  })),
  boolean: mock(() => ({
    kind: "boolean",
    optional: () => ({ kind: "optional-boolean" }),
  })),
  array: mock((item: unknown) => ({
    kind: "array",
    item,
    optional: () => ({ kind: "optional-array", item }),
  })),
  enum: mock((values: readonly string[]) => ({
    kind: "enum",
    values,
    optional: () => ({ kind: "optional-enum", values }),
  })),
  union: mock((schemas: unknown[]) => ({ kind: "union", schemas })),
};

mock.module("zod", () => ({ z: fakeZ }));

// Import AFTER mock.module so dynamic import resolves to the fake.
const { toAiSdkTool, buildAiSdkToolset } = await import("./zod-adapter");

beforeEach(() => {
  for (const fn of Object.values(fakeZ)) fn.mockClear();
});

const ctx: ToolContext = { agentType: "coordinator", stepBudgetMs: 5000 };

const stubTool: AgentTool<{ name: string; count?: number }, { ok: boolean }> = {
  name: "stub-tool",
  description: "A stub for testing",
  tier: "deterministic",
  allowedAgentTypes: ["coordinator"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "name field" },
      count: { type: "number", description: "optional count" },
    },
    required: ["name"],
  },
  validate(raw) {
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string")
      return { ok: false, error: "name must be string" };
    return { ok: true, data: r as { name: string; count?: number } };
  },
  async execute(input) {
    return { ok: true, _input: input } as any;
  },
};

describe("toAiSdkTool", () => {
  test("returns shape with description, inputSchema, execute", async () => {
    const adapted = await toAiSdkTool(stubTool, ctx);
    expect(adapted.description).toBe("A stub for testing");
    expect(adapted.inputSchema).toBeDefined();
    expect(typeof adapted.execute).toBe("function");
  });

  test("inputSchema maps properties via z.object", async () => {
    await toAiSdkTool(stubTool, ctx);
    expect(fakeZ.object).toHaveBeenCalledTimes(1);
    const objectArg = fakeZ.object.mock.calls[0]![0]!;
    expect(Object.keys(objectArg)).toEqual(["name", "count"]);
  });

  test("required field becomes non-optional", async () => {
    await toAiSdkTool(stubTool, ctx);
    expect(fakeZ.string).toHaveBeenCalled(); // for "name"
  });

  test("optional field becomes optional", async () => {
    await toAiSdkTool(stubTool, ctx);
    expect(fakeZ.number).toHaveBeenCalled(); // for "count"
  });

  test("execute validates input and forwards to tool.execute", async () => {
    const adapted = await toAiSdkTool(stubTool, ctx);
    const result = (await adapted.execute({ name: "x", count: 3 })) as any;
    expect(result.ok).toBe(true);
    expect(result._input).toEqual({ name: "x", count: 3 });
  });

  test("execute rejects invalid input with tool name in error", async () => {
    const adapted = await toAiSdkTool(stubTool, ctx);
    let err: Error | null = null;
    try {
      await adapted.execute({ name: 42 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("stub-tool");
    expect(err!.message).toContain("validation failed");
  });
});

describe("enum mapping", () => {
  test("string with enum becomes z.enum", async () => {
    const enumTool: AgentTool = {
      name: "enum-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          color: { type: "string", enum: ["red", "blue"] as const },
        },
        required: ["color"],
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    await toAiSdkTool(enumTool, ctx);
    expect(fakeZ.enum).toHaveBeenCalled();
  });
});

describe("array mapping", () => {
  test("array property requires 'items'", async () => {
    const badTool: AgentTool = {
      name: "bad-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array" }, // missing items
        },
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    let err: Error | null = null;
    try {
      await toAiSdkTool(badTool, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("array property missing 'items'");
  });

  test("valid array property maps via z.array", async () => {
    const arrTool: AgentTool = {
      name: "arr-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    await toAiSdkTool(arrTool, ctx);
    expect(fakeZ.array).toHaveBeenCalled();
  });
});

describe("buildAiSdkToolset", () => {
  test("adapts a list of tools into a name → AiSdkTool map", async () => {
    const t1: AgentTool<{ name: string; count?: number }, { ok: boolean }> = {
      ...stubTool,
      name: "t1",
    };
    const t2: AgentTool<{ name: string; count?: number }, { ok: boolean }> = {
      ...stubTool,
      name: "t2",
    };
    const set = await buildAiSdkToolset([t1, t2], ctx);
    expect(Object.keys(set).sort()).toEqual(["t1", "t2"]);
    expect(typeof set.t1!.execute).toBe("function");
  });
});

describe("propertyToZod — uncovered branches", () => {
  test("boolean property maps via z.boolean", async () => {
    const boolTool: AgentTool = {
      name: "bool-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          flag: { type: "boolean" },
        },
        required: ["flag"],
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    await toAiSdkTool(boolTool, ctx);
    expect(fakeZ.boolean).toHaveBeenCalled();
  });

  test("optional boolean calls .optional() on the schema", async () => {
    const boolTool: AgentTool = {
      name: "opt-bool-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          flag: { type: "boolean" },
        },
        // no required — so flag is optional
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    const adapted = await toAiSdkTool(boolTool, ctx);
    expect(adapted.inputSchema).toBeDefined();
    const shape = (adapted.inputSchema as any).shape as Record<string, any>;
    expect(shape["flag"]?.kind).toBe("optional-boolean");
  });

  test("object property type throws unsupported error", async () => {
    const nestedTool: AgentTool = {
      name: "nested-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          meta: { type: "object" },
        },
        required: ["meta"],
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    let err: Error | null = null;
    try {
      await toAiSdkTool(nestedTool, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("nested object properties not supported");
  });

  test("unknown property type throws descriptive error", async () => {
    const unknownTool: AgentTool = {
      name: "unknown-type-tool",
      description: "x",
      tier: "deterministic",
      allowedAgentTypes: ["coordinator"],
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "integer" as any },
        },
        required: ["x"],
      },
      validate: (raw) => ({ ok: true, data: raw }),
      execute: async () => ({}),
    };
    let err: Error | null = null;
    try {
      await toAiSdkTool(unknownTool, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("unknown property type");
    expect(err!.message).toContain("integer");
  });
});
