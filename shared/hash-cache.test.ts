import { describe, expect, test, beforeEach } from "bun:test";
import {
  traceHash,
  hashOf,
  getCached,
  setCached,
  cacheSize,
  clearCache,
} from "./hash-cache";

beforeEach(() => {
  clearCache();
});

// ─── traceHash (back-compat con la API original) ────────────────────────────

describe("traceHash", () => {
  test("produces a 64-char hex string", () => {
    const h = traceHash("sess-123", ["claude-sonnet-4-6"], 5000);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same inputs produce same hash", () => {
    const h1 = traceHash("sess-123", ["claude-sonnet-4-6"], 5000);
    const h2 = traceHash("sess-123", ["claude-sonnet-4-6"], 5000);
    expect(h1).toBe(h2);
  });

  test("model order is normalized — different order, same hash", () => {
    const h1 = traceHash(
      "sess-123",
      ["claude-opus-4-7", "claude-sonnet-4-6"],
      5000,
    );
    const h2 = traceHash(
      "sess-123",
      ["claude-sonnet-4-6", "claude-opus-4-7"],
      5000,
    );
    expect(h1).toBe(h2);
  });

  test("different session_id produces different hash", () => {
    const h1 = traceHash("sess-aaa", ["claude-sonnet-4-6"], 5000);
    const h2 = traceHash("sess-bbb", ["claude-sonnet-4-6"], 5000);
    expect(h1).not.toBe(h2);
  });

  test("different token count produces different hash", () => {
    const h1 = traceHash("sess-123", ["claude-sonnet-4-6"], 5000);
    const h2 = traceHash("sess-123", ["claude-sonnet-4-6"], 9999);
    expect(h1).not.toBe(h2);
  });
});

// ─── hashOf (API genérica) ──────────────────────────────────────────────────

describe("hashOf", () => {
  test("produces 64-char hex for arbitrary objects", () => {
    expect(hashOf({ a: 1, b: 2 })).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf("string-input")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf([1, 2, 3])).toMatch(/^[0-9a-f]{64}$/);
  });

  test("equivalent inputs produce same hash", () => {
    expect(hashOf({ x: 1 })).toBe(hashOf({ x: 1 }));
  });

  test("traceHash and hashOf agree on equivalent input", () => {
    const direct = hashOf({
      s: "sess-x",
      m: ["a", "b"].sort(),
      t: 100,
    });
    const viaTraceHash = traceHash("sess-x", ["a", "b"], 100);
    expect(direct).toBe(viaTraceHash);
  });
});

// ─── getCached / setCached ───────────────────────────────────────────────────

describe("getCached / setCached", () => {
  test("returns null for unknown hash", () => {
    expect(getCached("nonexistent")).toBeNull();
  });

  test("returns stored value for known hash", () => {
    setCached("hash-abc", "value-x");
    expect(getCached("hash-abc")).toBe("value-x");
  });

  test("cacheSize increments on new entries", () => {
    expect(cacheSize()).toBe(0);
    setCached("h1", "v1");
    setCached("h2", "v2");
    expect(cacheSize()).toBe(2);
  });

  test("overwriting same hash updates value", () => {
    setCached("hash-abc", "old");
    setCached("hash-abc", "new");
    expect(getCached("hash-abc")).toBe("new");
  });

  test("clearCache resets to 0", () => {
    setCached("h1", "v");
    clearCache();
    expect(cacheSize()).toBe(0);
    expect(getCached("h1")).toBeNull();
  });

  test("cache survives moderate batch insert without unbounded growth", () => {
    for (let i = 0; i < 200; i++) setCached(`h-${i}`, `v-${i}`);
    expect(cacheSize()).toBe(200);
  });
});
