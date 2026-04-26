import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";

// ─── chrome stub ─────────────────────────────────────────────────────────────
// El service worker usa chrome.storage.local. Lo mockeamos a un objeto en
// memoria antes de importar el módulo.

interface ChromeStub {
  storage: {
    local: {
      _store: Record<string, unknown>;
      _shouldThrowOnGet: boolean;
      _shouldThrowOnSet: boolean;
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (kv: Record<string, unknown>) => Promise<void>;
    };
  };
}

const chromeStub: ChromeStub = {
  storage: {
    local: {
      _store: {},
      _shouldThrowOnGet: false,
      _shouldThrowOnSet: false,
      async get(key) {
        if (this._shouldThrowOnGet) throw new Error("get failed");
        return key in this._store ? { [key]: this._store[key] } : {};
      },
      async set(kv) {
        if (this._shouldThrowOnSet) throw new Error("set failed");
        Object.assign(this._store, kv);
      },
    },
  },
};

(globalThis as unknown as { chrome: ChromeStub }).chrome = chromeStub;

// Importamos DESPUÉS de instalar el stub para que el módulo encuentre
// chrome.storage en runtime.
const { emitDegradation } = await import("./degradation.js");

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("emitDegradation (extension)", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    chromeStub.storage.local._store = {};
    chromeStub.storage.local._shouldThrowOnGet = false;
    chromeStub.storage.local._shouldThrowOnSet = false;
    // eslint-disable-next-line no-console
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("logs to console.warn with [atlax-extension] prefix", async () => {
    await emitDegradation("test:source", new Error("boom"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0];
    expect(args[0]).toBe("[atlax-extension]");
    const parsed = JSON.parse(args[1] as string);
    expect(parsed.type).toBe("degradation");
    expect(parsed.source).toBe("test:source");
    expect(parsed.error).toBe("boom");
  });

  test("persists to chrome.storage.local under degradationLog key", async () => {
    await emitDegradation("net:fetch", new Error("network"));
    const stored = chromeStub.storage.local._store
      .degradationLog as Array<unknown>;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
    const entry = stored[0] as Record<string, unknown>;
    expect(entry.type).toBe("degradation");
    expect(entry.source).toBe("net:fetch");
    expect(entry.error).toBe("network");
  });

  test("appends to existing log without losing prior entries", async () => {
    await emitDegradation("a", new Error("e1"));
    await emitDegradation("b", new Error("e2"));
    await emitDegradation("c", new Error("e3"));
    const stored = chromeStub.storage.local._store.degradationLog as Array<{
      source: string;
    }>;
    expect(stored).toHaveLength(3);
    expect(stored.map((e) => e.source)).toEqual(["a", "b", "c"]);
  });

  test("trims to 50 entries (rolling buffer)", async () => {
    for (let i = 0; i < 60; i++) {
      await emitDegradation(`source-${i}`, new Error(`e${i}`));
    }
    const stored = chromeStub.storage.local._store.degradationLog as Array<{
      source: string;
    }>;
    expect(stored).toHaveLength(50);
    // The oldest entries (0-9) should have been dropped
    expect(stored[0]!.source).toBe("source-10");
    expect(stored[49]!.source).toBe("source-59");
  });

  test("string errors handled correctly", async () => {
    await emitDegradation("x", "string error");
    const stored = chromeStub.storage.local._store.degradationLog as Array<{
      error: string;
    }>;
    expect(stored[0]!.error).toBe("string error");
  });

  test("does NOT throw if chrome.storage.local.get throws", async () => {
    chromeStub.storage.local._shouldThrowOnGet = true;
    await expect(emitDegradation("x", new Error("e"))).resolves.toBeUndefined();
    // console.warn must still have been called
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT throw if chrome.storage.local.set throws", async () => {
    chromeStub.storage.local._shouldThrowOnSet = true;
    await expect(emitDegradation("x", new Error("e"))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("ts is a valid ISO-8601 timestamp", async () => {
    await emitDegradation("x", new Error("e"));
    const args = warnSpy.mock.calls[0];
    const parsed = JSON.parse(args[1] as string);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // valid: parses back to a Date
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });
});
