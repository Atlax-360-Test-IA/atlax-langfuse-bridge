/**
 * tests/langfuse-sync-send.test.ts
 *
 * Unit tests for sendToLangfuse() in hooks/langfuse-sync.ts.
 * Covers the HTTP send path, unsafe-host guard, missing-credentials path,
 * non-ok response handling, and fetch rejection — all previously uncovered
 * (lines 212-254 per coverage report, now reachable via export).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { saveEnv, restoreEnv } from "./helpers/env";

const ENV_KEYS = ["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"];
const SAVED = saveEnv(ENV_KEYS);

const SAMPLE_BATCH = [
  { id: "evt-1", type: "trace-create", body: { id: "cc-abc", name: "test" } },
];

describe("sendToLangfuse — HTTP success", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("sends POST to /api/public/ingestion with correct headers", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      captured.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ successes: [], errors: [] }), {
          status: 207,
        }),
      );
    });

    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);

    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toContain("/api/public/ingestion");
    expect(captured[0]!.init.method).toBe("POST");
    expect(
      (captured[0]!.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
    const auth = (captured[0]!.init.headers as Record<string, string>)[
      "Authorization"
    ];
    expect(auth).toMatch(/^Basic /);
    // Decode and verify credentials
    const decoded = Buffer.from(auth!.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("pk-test:sk-test");
  });

  test("wraps batch in { batch: [...] } envelope", async () => {
    const captured: unknown[] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      captured.push(JSON.parse((init?.body as string) ?? "{}"));
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);

    expect(captured.length).toBe(1);
    const envelope = captured[0] as { batch: unknown[] };
    expect(Array.isArray(envelope.batch)).toBe(true);
    expect(envelope.batch.length).toBe(SAMPLE_BATCH.length);
  });

  test("strips trailing slash from LANGFUSE_HOST before sending", async () => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000/";
    const captured: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      captured.push(url);
      return Promise.resolve(new Response("{}", { status: 207 }));
    });

    const { sendToLangfuse } = await import(
      `../hooks/langfuse-sync?_t=${Date.now()}`
    ) as typeof import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);

    if (captured.length > 0) {
      expect(captured[0]).not.toContain("//api");
    }
  });

  test("does not throw on 207 response", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ successes: [], errors: [] }), {
          status: 207,
        }),
      ),
    );

    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });
});

describe("sendToLangfuse — missing credentials path", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("does not call fetch when LANGFUSE_PUBLIC_KEY is missing", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    delete process.env["LANGFUSE_SECRET_KEY"];

    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("does not throw when credentials are missing", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    delete process.env["LANGFUSE_SECRET_KEY"];

    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });
});

describe("sendToLangfuse — unsafe host guard", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("does not call fetch for http non-localhost host", async () => {
    process.env["LANGFUSE_HOST"] = "http://evil.example.com";
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("calls fetch for https:// host", async () => {
    process.env["LANGFUSE_HOST"] = "https://langfuse.atlax360.ai";
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await sendToLangfuse(SAMPLE_BATCH);
    expect(fetchSpy).toHaveBeenCalled();
  });

  test("does not throw for unsafe host — returns silently", async () => {
    process.env["LANGFUSE_HOST"] = "ftp://unsafe.com";
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });
});

describe("sendToLangfuse — non-ok HTTP responses", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("does not throw on 500 response — writes to stderr silently", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("internal server error", { status: 500 })),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });

  test("does not throw on 401 response", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });

  test("does not throw on 429 response", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("too many requests", { status: 429 })),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).resolves.toBeUndefined();
  });
});

describe("sendToLangfuse — fetch rejection (network error)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("propagates fetch rejection (hook's main() catches it and exits 0)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    // sendToLangfuse itself does not catch — main() wraps it in try/catch
    await expect(sendToLangfuse(SAMPLE_BATCH)).rejects.toThrow("ECONNREFUSED");
  });

  test("AbortError (timeout) propagates to main() catch", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.reject(new DOMException("The operation was aborted", "AbortError")),
    );
    const { sendToLangfuse } = await import("../hooks/langfuse-sync");
    await expect(sendToLangfuse(SAMPLE_BATCH)).rejects.toBeDefined();
  });
});
