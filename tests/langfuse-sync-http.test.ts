/**
 * E2E HTTP test for hooks/langfuse-sync.ts
 *
 * Runs the hook as a real subprocess (Bun.spawn) with a fixture JSONL,
 * captures the POST /api/public/ingestion request in a Bun.serve mock,
 * and validates the Langfuse batch structure end-to-end without hitting
 * a real Langfuse instance.
 *
 * This catches regressions that unit tests miss: serialization errors,
 * auth header encoding, env var wiring, and batch schema drift.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "session.jsonl");
const HOOK_PATH = join(import.meta.dir, "../hooks/langfuse-sync.ts");
const SESSION_ID = "test-e2e-http-abc";

// ─── Mock Langfuse server ─────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  auth: string | null;
  contentType: string | null;
  body: unknown;
}

let captured: CapturedRequest | null = null;
let serverPort = 0;

const mockServer = Bun.serve({
  port: 0, // OS assigns free port
  fetch(req) {
    const url = new URL(req.url);
    return req.json().then((body) => {
      captured = {
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("Authorization"),
        contentType: req.headers.get("Content-Type"),
        body,
      };
      return new Response(JSON.stringify({ successes: [], errors: [] }), {
        status: 207,
        headers: { "Content-Type": "application/json" },
      });
    });
  },
});

beforeAll(() => {
  serverPort = mockServer.port!;
});

afterAll(() => {
  mockServer.stop(true);
});

// ─── Helper: run hook subprocess ─────────────────────────────────────────────

async function runHook(
  sessionId: string,
  transcriptPath: string,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const stopEvent = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: "/tmp/test-cwd",
    permission_mode: "default",
    hook_event_name: "Stop",
  });

  const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
    stdin: new TextEncoder().encode(stopEvent),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      LANGFUSE_HOST: `http://127.0.0.1:${serverPort}`,
      LANGFUSE_PUBLIC_KEY: "pk-test-e2e",
      LANGFUSE_SECRET_KEY: "sk-test-e2e",
      LANGFUSE_USER_ID: "e2e-test@atlax360.com",
      HOME: process.env["HOME"] ?? "/tmp",
      ATLAX_TRANSCRIPT_ROOT_OVERRIDE: join(import.meta.dir, "fixtures"),
      ...extraEnv,
    },
    cwd: join(import.meta.dir, ".."),
  });

  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode ?? -1, stderr };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("langfuse-sync → Bun.serve mock HTTP", () => {
  test("hook exits 0 and sends POST to /api/public/ingestion", async () => {
    captured = null;
    const { exitCode, stderr } = await runHook(SESSION_ID, FIXTURE_PATH);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("LANGFUSE_PUBLIC_KEY");
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.path).toBe("/api/public/ingestion");
  });

  test("Authorization header is Basic base64(pk:sk)", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    expect(captured!.auth).toStartWith("Basic ");
    const decoded = atob(captured!.auth!.slice(6));
    expect(decoded).toBe("pk-test-e2e:sk-test-e2e");
  });

  test("Content-Type is application/json", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);
    expect(captured!.contentType).toContain("application/json");
  });

  test("batch contains trace-create event", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    expect(Array.isArray(body.batch)).toBe(true);
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    expect(trace).toBeTruthy();
  });

  test("trace-create body has correct traceId and sessionId", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const traceBody = trace!["body"] as Record<string, unknown>;
    expect(traceBody["id"]).toBe(`cc-${SESSION_ID}`);
    expect(traceBody["sessionId"]).toBe(SESSION_ID);
    expect(traceBody["userId"]).toBe("e2e-test@atlax360.com");
  });

  test("batch contains at least one generation-create event", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const generations = body.batch.filter(
      (e) => e["type"] === "generation-create",
    );
    expect(generations.length).toBeGreaterThan(0);
  });

  test("generation-create links to correct traceId", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const gen = body.batch.find((e) => e["type"] === "generation-create");
    const genBody = gen!["body"] as Record<string, unknown>;
    expect(genBody["traceId"]).toBe(`cc-${SESSION_ID}`);
    expect(typeof genBody["model"]).toBe("string");
  });

  test("trace tags include project: and billing: prefixes", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);

    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags.some((t) => t.startsWith("project:"))).toBe(true);
    expect(tags.some((t) => t.startsWith("billing:"))).toBe(true);
  });

  test("hook exits 0 and emits degradation when LANGFUSE_HOST is unsafe", async () => {
    captured = null;
    const { exitCode, stderr } = await runHook(SESSION_ID, FIXTURE_PATH, {
      LANGFUSE_HOST: "http://169.254.169.254/latest/meta-data/",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("unsafe-host");
    expect(captured).toBeNull(); // no request sent
  });

  test("trace tags include source:reconciler when _invokedByReconciler=true (S22-A)", async () => {
    captured = null;
    // Run hook with reconciler flag — simulates reconciler replay path
    const stopEvent = JSON.stringify({
      session_id: SESSION_ID,
      transcript_path: FIXTURE_PATH,
      cwd: "/tmp/test-cwd",
      permission_mode: "default",
      hook_event_name: "Stop",
      _invokedByReconciler: true,
    });
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdin: new TextEncoder().encode(stopEvent),
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        LANGFUSE_HOST: `http://127.0.0.1:${serverPort}`,
        LANGFUSE_PUBLIC_KEY: "pk-test-e2e",
        LANGFUSE_SECRET_KEY: "sk-test-e2e",
        LANGFUSE_USER_ID: "e2e-test@atlax360.com",
        HOME: process.env["HOME"] ?? "/tmp",
        ATLAX_TRANSCRIPT_ROOT_OVERRIDE: join(import.meta.dir, "fixtures"),
      },
      cwd: join(import.meta.dir, ".."),
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(captured).not.toBeNull();
    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags).toContain("source:reconciler");
  });

  test("trace tags do NOT include source:reconciler in normal hook invocation", async () => {
    captured = null;
    await runHook(SESSION_ID, FIXTURE_PATH);
    const body = captured!.body as { batch: Array<Record<string, unknown>> };
    const trace = body.batch.find((e) => e["type"] === "trace-create");
    const tags = (trace!["body"] as Record<string, unknown>)[
      "tags"
    ] as string[];
    expect(tags).not.toContain("source:reconciler");
  });

  test("hook exits 0 with empty stdin (no transcript)", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdin: new TextEncoder().encode(""),
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        LANGFUSE_HOST: `http://127.0.0.1:${serverPort}`,
        LANGFUSE_PUBLIC_KEY: "pk-test-e2e",
        LANGFUSE_SECRET_KEY: "sk-test-e2e",
      },
      cwd: join(import.meta.dir, ".."),
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });
});
