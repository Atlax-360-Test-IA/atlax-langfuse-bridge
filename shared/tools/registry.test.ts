import { describe, expect, test } from "bun:test";
import { listToolsForAgent, getTool, listAllToolNames } from "./registry";

describe("registry access control", () => {
  test("coordinator sees both tools", () => {
    const tools = listToolsForAgent("coordinator");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate-observation",
      "query-langfuse-trace",
    ]);
  });

  test("trace-analyst sees only query (read-only agent)", () => {
    const tools = listToolsForAgent("trace-analyst");
    expect(tools.map((t) => t.name)).toEqual(["query-langfuse-trace"]);
  });

  test("annotator sees only annotate", () => {
    const tools = listToolsForAgent("annotator");
    expect(tools.map((t) => t.name)).toEqual(["annotate-observation"]);
  });
});

describe("getTool", () => {
  test("returns tool when authorized", () => {
    const t = getTool("query-langfuse-trace", "coordinator");
    expect(t).not.toBeNull();
    expect(t!.name).toBe("query-langfuse-trace");
  });

  test("returns null when agent not authorized", () => {
    const t = getTool("annotate-observation", "trace-analyst");
    expect(t).toBeNull();
  });

  test("returns null for unknown tool name", () => {
    const t = getTool("nonexistent-tool", "coordinator");
    expect(t).toBeNull();
  });
});

describe("listAllToolNames", () => {
  test("includes all registered tools", () => {
    const names = listAllToolNames();
    expect(names).toContain("query-langfuse-trace");
    expect(names).toContain("annotate-observation");
  });
});

describe("tool contract invariants", () => {
  test("every tool has non-empty allowedAgentTypes", () => {
    const allTools = [
      ...listToolsForAgent("coordinator"),
      ...listToolsForAgent("trace-analyst"),
      ...listToolsForAgent("annotator"),
    ];
    for (const t of allTools) {
      expect(t.allowedAgentTypes.length).toBeGreaterThan(0);
    }
  });

  test("every tool name is kebab-case", () => {
    for (const name of listAllToolNames()) {
      expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});
