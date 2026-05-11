/**
 * tests/langfuse-sync-main.test.ts
 *
 * Unit tests for processStopEvent() in hooks/langfuse-sync.ts.
 *
 * Strategy:
 * - Error paths call process.exit(0). We spy on process.exit to throw a
 *   sentinel Error("exit:0") so async functions reject instead of terminating.
 * - Success path: spy on globalThis.fetch to intercept sendToLangfuse's HTTP
 *   call and assert the batch envelope shape.
 * - ATLAX_TRANSCRIPT_ROOT_OVERRIDE points safe root at tests/fixtures/ so
 *   transcript_path validation doesn't need ~/.claude/projects.
 * - LANGFUSE_USER_ID skips the execSync("git config user.email") subprocess.
 * - All env vars restored via saveEnv/restoreEnv (I-12).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { saveEnv, restoreEnv } from "./helpers/env";

// Dynamic import with query-string bypass prevents ESM cache contamination
// with langfuse-sync-send.test.ts which imports the same module.
const { processStopEvent } = (await import(
  `../hooks/langfuse-sync?_unit=${Date.now()}`
)) as typeof import("../hooks/langfuse-sync");

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const SESSION_FIXTURE = path.join(FIXTURES_DIR, "session.jsonl");

const ENV_KEYS = [
  "ATLAX_TRANSCRIPT_ROOT_OVERRIDE",
  "LANGFUSE_HOST",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_USER_ID",
  "CLAUDE_DEV_NAME",
  "CLAUDE_CODE_USE_VERTEX",
  "LANGFUSE_FORCE_NOW_TIMESTAMP",
];
const SAVED = saveEnv(ENV_KEYS);

function makeStopEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: "test-session-abc",
    transcript_path: SESSION_FIXTURE,
    cwd: "/home/dev/work/project",
    permission_mode: "default",
    ...overrides,
  });
}

// ─── Error paths ─────────────────────────────────────────────────────────────

describe("processStopEvent — error paths (exit 0)", () => {
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit:0");
    });
    process.env["ATLAX_TRANSCRIPT_ROOT_OVERRIDE"] = FIXTURES_DIR;
    process.env["LANGFUSE_USER_ID"] = "test@example.com";
  });

  afterEach(() => {
    exitSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("JSON inválido → emite degradation y sale con exit 0", async () => {
    await expect(processStopEvent("not valid json {{{")).rejects.toThrow(
      "exit:0",
    );
  });

  test("session_id no es string → emite degradation y sale con exit 0", async () => {
    const raw = JSON.stringify({
      hook_event_name: "Stop",
      session_id: 42,
      transcript_path: SESSION_FIXTURE,
      cwd: "/home/dev/work/project",
      permission_mode: "default",
    });
    await expect(processStopEvent(raw)).rejects.toThrow("exit:0");
  });

  test("transcript_path es null → emite degradation y sale con exit 0", async () => {
    const raw = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "abc",
      transcript_path: null,
      cwd: "/home/dev/work/project",
      permission_mode: "default",
    });
    await expect(processStopEvent(raw)).rejects.toThrow("exit:0");
  });

  test("transcript_path escapa el safe root → emite degradation y sale con exit 0", async () => {
    const escapingPath = path.join(os.tmpdir(), "evil.jsonl");
    const raw = makeStopEvent({ transcript_path: escapingPath });
    await expect(processStopEvent(raw)).rejects.toThrow("exit:0");
  });

  test("fichero dentro del safe root pero inexistente → emite degradation y sale con exit 0", async () => {
    const missingPath = path.join(FIXTURES_DIR, "does-not-exist-xyz.jsonl");
    const raw = makeStopEvent({ transcript_path: missingPath });
    await expect(processStopEvent(raw)).rejects.toThrow("exit:0");
  });

  test("JSONL sin entradas de modelo (models.size === 0) → sale con exit 0 sin enviar", async () => {
    const tmpFile = path.join(FIXTURES_DIR, "no-models-tmp.jsonl");
    writeFileSync(
      tmpFile,
      [
        JSON.stringify({
          type: "summary",
          timestamp: "2026-04-15T10:00:00.000Z",
          cwd: "/tmp/proj",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
        }),
      ].join("\n"),
    );
    try {
      const raw = makeStopEvent({ transcript_path: tmpFile });
      await expect(processStopEvent(raw)).rejects.toThrow("exit:0");
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

// ─── Success path ─────────────────────────────────────────────────────────────

describe("processStopEvent — success path (JSONL válido → llama fetch)", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit:0");
    });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    process.env["ATLAX_TRANSCRIPT_ROOT_OVERRIDE"] = FIXTURES_DIR;
    process.env["LANGFUSE_USER_ID"] = "test@example.com";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("fixture con turns de assistant → resuelve sin exit, llama fetch con trace-create + generation-create", async () => {
    const raw = makeStopEvent({ transcript_path: SESSION_FIXTURE });

    await expect(processStopEvent(raw)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const envelope = JSON.parse(init.body as string) as {
      batch: Array<{ type: string }>;
    };
    expect(Array.isArray(envelope.batch)).toBe(true);
    expect(envelope.batch.length).toBeGreaterThan(1);

    const types = envelope.batch.map((e) => e.type);
    expect(types).toContain("trace-create");
    expect(types).toContain("generation-create");
  });

  test("traceId sigue el patrón cc-<session_id>", async () => {
    const raw = makeStopEvent({
      session_id: "my-session-xyz",
      transcript_path: SESSION_FIXTURE,
    });

    await expect(processStopEvent(raw)).resolves.toBeUndefined();

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const envelope = JSON.parse(init.body as string) as {
      batch: Array<{ type: string; body: { id: string } }>;
    };
    const traceEvent = envelope.batch.find((e) => e.type === "trace-create");
    expect(traceEvent?.body.id).toBe("cc-my-session-xyz");
  });

  test("_invokedByReconciler=true agrega tag source:reconciler", async () => {
    const raw = makeStopEvent({
      transcript_path: SESSION_FIXTURE,
      _invokedByReconciler: true,
    });

    await expect(processStopEvent(raw)).resolves.toBeUndefined();

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const envelope = JSON.parse(init.body as string) as {
      batch: Array<{ type: string; body: { tags?: string[] } }>;
    };
    const traceEvent = envelope.batch.find((e) => e.type === "trace-create");
    expect(traceEvent?.body.tags).toContain("source:reconciler");
  });
});
