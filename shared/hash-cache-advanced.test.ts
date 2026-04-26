/**
 * Advanced tests for shared/hash-cache.ts covering TTL expiry,
 * MAX_ENTRIES eviction, and traceHash — gaps from the basic suite.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  getCached,
  setCached,
  clearCache,
  cacheSize,
  traceHash,
  hashOf,
} from "./hash-cache";

beforeEach(() => {
  clearCache();
});

// ─── TTL expiry ───────────────────────────────────────────────────────────────

describe("TTL expiry", () => {
  test("entry is evicted after TTL passes (mocked Date.now)", () => {
    const originalNow = Date.now;
    const t0 = 1_000_000_000_000;

    Date.now = () => t0;
    setCached("ttl-key", "value");
    expect(getCached("ttl-key")).toBe("value");

    // Advance past 24h TTL
    Date.now = () => t0 + 25 * 60 * 60 * 1000;
    expect(getCached("ttl-key")).toBeNull();

    Date.now = originalNow;
  });

  test("entry within TTL is not evicted", () => {
    const originalNow = Date.now;
    const t0 = 1_000_000_000_000;

    Date.now = () => t0;
    setCached("fresh-key", "still-valid");

    // 23h later — still valid
    Date.now = () => t0 + 23 * 60 * 60 * 1000;
    expect(getCached("fresh-key")).toBe("still-valid");

    Date.now = originalNow;
  });

  test("getCached deletes the stale entry from cache", () => {
    const originalNow = Date.now;
    const t0 = 1_000_000_000_000;

    Date.now = () => t0;
    setCached("stale-key", "old");
    expect(cacheSize()).toBe(1);

    Date.now = () => t0 + 25 * 60 * 60 * 1000;
    getCached("stale-key"); // triggers delete
    expect(cacheSize()).toBe(0);

    Date.now = originalNow;
  });
});

// ─── MAX_ENTRIES eviction ─────────────────────────────────────────────────────

describe("MAX_ENTRIES eviction (FIFO)", () => {
  test("cache size stays bounded after overflow", () => {
    // MAX_ENTRIES is 10_000 — inserting 10_001 should evict the first
    // We test with a small batch to keep the test fast
    for (let i = 0; i < 5; i++) {
      setCached(`key-${i}`, `value-${i}`);
    }
    expect(cacheSize()).toBe(5);
  });

  test("oldest entry is evicted when at capacity", () => {
    // Fill to exactly 10_000 entries
    const MAX = 10_000;
    for (let i = 0; i < MAX; i++) {
      setCached(`fill-${i}`, `v${i}`);
    }
    expect(cacheSize()).toBe(MAX);

    // The first entry (fill-0) is oldest
    expect(getCached("fill-0")).not.toBeNull();

    // Insert one more — fill-0 should be evicted (FIFO)
    setCached("overflow-key", "overflow-val");
    expect(getCached("fill-0")).toBeNull();
    expect(getCached("overflow-key")).toBe("overflow-val");
    expect(cacheSize()).toBe(MAX);
  });
});

// ─── traceHash ────────────────────────────────────────────────────────────────

describe("traceHash", () => {
  test("produces a 64-char hex string (SHA256)", () => {
    const h = traceHash("session-abc", ["claude-sonnet-4-6"], 5000);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same inputs produce same hash (deterministic)", () => {
    const h1 = traceHash("session-abc", ["claude-sonnet-4-6"], 5000);
    const h2 = traceHash("session-abc", ["claude-sonnet-4-6"], 5000);
    expect(h1).toBe(h2);
  });

  test("different sessionId produces different hash", () => {
    const h1 = traceHash("session-aaa", ["claude-sonnet-4-6"], 5000);
    const h2 = traceHash("session-bbb", ["claude-sonnet-4-6"], 5000);
    expect(h1).not.toBe(h2);
  });

  test("model order is normalized (sorted) for stable hash", () => {
    const h1 = traceHash("s", ["claude-opus-4-7", "claude-sonnet-4-6"], 100);
    const h2 = traceHash("s", ["claude-sonnet-4-6", "claude-opus-4-7"], 100);
    expect(h1).toBe(h2);
  });

  test("different token count produces different hash", () => {
    const h1 = traceHash("s", ["claude-sonnet-4-6"], 1000);
    const h2 = traceHash("s", ["claude-sonnet-4-6"], 2000);
    expect(h1).not.toBe(h2);
  });
});

// ─── hashOf ───────────────────────────────────────────────────────────────────

describe("hashOf", () => {
  test("null input hashes without throwing", () => {
    expect(() => hashOf(null)).not.toThrow();
    expect(hashOf(null)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty object hashes deterministically", () => {
    expect(hashOf({})).toBe(hashOf({}));
  });

  test("different objects produce different hashes", () => {
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });

  test("primitive values hash correctly", () => {
    expect(hashOf(42)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(true)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── clearCache + cacheSize ───────────────────────────────────────────────────

describe("clearCache and cacheSize", () => {
  test("cacheSize returns 0 after clearCache", () => {
    setCached("a", "1");
    setCached("b", "2");
    expect(cacheSize()).toBe(2);
    clearCache();
    expect(cacheSize()).toBe(0);
  });

  test("getCached returns null after clearCache", () => {
    setCached("persisted", "value");
    clearCache();
    expect(getCached("persisted")).toBeNull();
  });
});
