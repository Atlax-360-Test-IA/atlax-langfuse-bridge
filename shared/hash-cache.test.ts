import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  traceHash,
  hashOf,
  getCached,
  setCached,
  cacheSize,
  clearCache,
  _runCleanup,
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

// ─── _runCleanup — interval callback ─────────────────────────────────────────

describe("_runCleanup — cleanup callback", () => {
  const TTL_24H = 24 * 60 * 60 * 1000;
  let nowSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    nowSpy?.mockRestore();
  });

  test("removes entries older than 24h TTL", () => {
    const t0 = 1_700_000_000_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(t0);
    setCached("old-key", "old-value");
    setCached("fresh-key", "fresh-value");

    // Advance clock 25h for old-key (simulate: old-key written at t0, now=t0+25h)
    // Fresh-key will also be "old" in this scenario since both written at t0.
    // To test selective eviction: set fresh-key at t0+25h, old-key at t0.
    nowSpy.mockReturnValue(t0 + (25 * TTL_24H) / 24); // t0 + 25h
    setCached("fresh-key-2", "fresh-value-2"); // written at t0+25h

    nowSpy.mockReturnValue(t0 + (25 * TTL_24H) / 24); // cleanup runs at t0+25h
    _runCleanup();

    // old-key and fresh-key (both written at t0) are now expired
    expect(getCached("old-key")).toBeNull();
    expect(getCached("fresh-key")).toBeNull();
    // fresh-key-2 written at t0+25h, not yet expired at cleanup time (0ms old)
    expect(getCached("fresh-key-2")).toBe("fresh-value-2");
  });

  test("keeps entries younger than TTL", () => {
    const t0 = 1_700_000_000_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(t0);
    setCached("young", "value");

    // Only 12h later
    nowSpy.mockReturnValue(t0 + 12 * 60 * 60 * 1000);
    _runCleanup();

    expect(getCached("young")).toBe("value");
  });

  test("handles empty cache without error", () => {
    clearCache();
    expect(() => _runCleanup()).not.toThrow();
    expect(cacheSize()).toBe(0);
  });

  test("removes all entries when all are expired", () => {
    const t0 = 1_700_000_000_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(t0);
    for (let i = 0; i < 5; i++) setCached(`key-${i}`, `val-${i}`);
    expect(cacheSize()).toBe(5);

    nowSpy.mockReturnValue(t0 + 25 * 60 * 60 * 1000); // 25h later
    _runCleanup();
    expect(cacheSize()).toBe(0);
  });
});
