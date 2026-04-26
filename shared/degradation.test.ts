import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { emitDegradation, type DegradationEntry } from "./degradation";

describe("emitDegradation", () => {
  const written: string[] = [];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    written.length = 0;
    spy = spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      written.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test("emits a JSON line to stderr", () => {
    emitDegradation("test:source", new Error("boom"));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as DegradationEntry;
    expect(parsed.type).toBe("degradation");
    expect(parsed.source).toBe("test:source");
    expect(parsed.error).toBe("boom");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("accepts string errors", () => {
    emitDegradation("test:source", "string error");
    const parsed = JSON.parse(written[0]!) as DegradationEntry;
    expect(parsed.error).toBe("string error");
  });

  test("accepts non-Error objects", () => {
    emitDegradation("test:source", { code: 42 });
    const parsed = JSON.parse(written[0]!) as DegradationEntry;
    expect(parsed.error).toBe("[object Object]");
  });

  test("output is valid JSON (parseable line)", () => {
    emitDegradation("x", new Error("e"));
    expect(() => JSON.parse(written[0]!)).not.toThrow();
  });

  test("writes exactly one line per call", () => {
    emitDegradation("x", new Error("e"));
    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith("\n")).toBe(true);
  });

  test("different sources produce different source fields", () => {
    emitDegradation("source-a", new Error("e"));
    emitDegradation("source-b", new Error("e"));
    const a = JSON.parse(written[0]!) as DegradationEntry;
    const b = JSON.parse(written[1]!) as DegradationEntry;
    expect(a.source).toBe("source-a");
    expect(b.source).toBe("source-b");
  });
});
