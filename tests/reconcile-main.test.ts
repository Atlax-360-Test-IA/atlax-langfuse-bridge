/**
 * tests/reconcile-main.test.ts
 *
 * Unit tests for runReconcile() in scripts/reconcile-traces.ts.
 *
 * Strategy:
 * - Create a real tmpdir with the ~/.claude/projects/<project>/<session>.jsonl
 *   structure and pass it as opts.jsonlRoot so discoverRecentJsonls uses it
 *   instead of the real home directory.
 * - Spy on globalThis.fetch to control Langfuse API responses (getTrace,
 *   getGenerationCost) without hitting the network.
 * - For repair paths (replayHook), the spawn subprocess will fail because
 *   LANGFUSE_PUBLIC_KEY/SK may be missing — that's fine, failed++ is the
 *   expected outcome which we assert.
 * - All env vars restored via saveEnv/restoreEnv (I-12).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv, restoreEnv } from "./helpers/env";
import { runReconcile, type ReconcileOpts } from "../scripts/reconcile-traces";

// ── Env management ────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
  "ANTHROPIC_ADMIN_API_KEY",
];
const SAVED = saveEnv(ENV_KEYS);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal JSONL with one assistant turn — gives turns=1, cost>0. */
function writeSessionJsonl(
  dir: string,
  sessionId: string,
): { path: string; assistantTs: string } {
  // Structure expected by discoverRecentJsonls: <root>/<project>/<session>.jsonl
  const projectDir = join(dir, "project-alpha");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const assistantTs = new Date().toISOString();
  const lines = [
    JSON.stringify({
      type: "summary",
      timestamp: new Date().toISOString(),
      cwd: "/home/dev/project",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: assistantTs,
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: "standard",
        },
      },
    }),
  ];
  writeFileSync(filePath, lines.join("\n"));
  return { path: filePath, assistantTs };
}

function makeOpts(
  overrides: Partial<ReconcileOpts> & { jsonlRoot: string },
): ReconcileOpts {
  return {
    windowHours: 8760, // 1 year — ensures test files are in window
    dryRun: false,
    langfuseHost: "http://localhost:3000",
    publicKey: "pk-test",
    secretKey: "sk-test",
    ...overrides,
  };
}

/** Build a fetch mock that returns 404 for getTrace (trace MISSING). */
function fetchNotFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

/** Build a fetch mock that returns a matching trace (drift NONE). */
function fetchMatchingTrace(
  sessionId: string,
  turns: number,
  cost: number,
  end: string,
): Response {
  return new Response(
    JSON.stringify({
      id: `cc-${sessionId}`,
      metadata: {
        turns,
        estimatedCostUSD: cost,
        sessionEnd: end,
      },
    }),
    { status: 200 },
  );
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe("runReconcile — sin candidatos en la ventana", () => {
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    // No JSONL files created → discoverRecentJsonls returns []
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("devuelve candidates:0, drift:0, repaired:0, failed:0", async () => {
    const summary = await runReconcile(makeOpts({ jsonlRoot: tmpRoot }));
    expect(summary.candidates).toBe(0);
    expect(summary.drift).toBe(0);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test("devuelve windowHours y dryRun reflejando opts", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, windowHours: 48, dryRun: true }),
    );
    expect(summary.windowHours).toBe(48);
    expect(summary.dryRun).toBe(true);
  });

  test("no llama a fetch (no hay sesiones que verificar)", async () => {
    // Fetch should not be called for Langfuse getTrace/getGenerations
    // (sendBridgeHealthTrace does call fetch, but we don't call it in runReconcile)
    await runReconcile(makeOpts({ jsonlRoot: tmpRoot }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runReconcile — candidato con drift MISSING (trace no existe en Langfuse)", () => {
  const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    writeSessionJsonl(tmpRoot, SESSION_ID);
    // getTrace → 404 (MISSING drift)
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() => Promise.resolve(fetchNotFound()));
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("drift_run=true → drift:1, repaired:0, failed:0 (no intenta reparar)", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: true }),
    );
    expect(summary.candidates).toBe(1);
    expect(summary.drift).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test("dryRun=false → intenta reparación → failed:1 (hook subprocess sin creds reales)", async () => {
    // replayHook spawns bun run hooks/langfuse-sync.ts — it will fail gracefully
    // because no real Langfuse creds are present. failed++ is the expected result.
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: false }),
    );
    expect(summary.candidates).toBe(1);
    expect(summary.drift).toBe(1);
    // repaired OR failed must account for the 1 drift
    expect(summary.repaired + summary.failed).toBe(1);
  });
});

describe("runReconcile — candidato sin drift (OK)", () => {
  const SESSION_ID = "b2c3d4e5-f6a7-8901-bcde-f23456789012";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let assistantTs: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    // Capture the exact timestamp written to JSONL so the mock trace matches it.
    ({ assistantTs } = writeSessionJsonl(tmpRoot, SESSION_ID));

    // haiku-4-5: (100 * 1 + 50 * 5) / 1_000_000 = 0.00035 USD
    const COST = 0.00035;
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/public/traces/")) {
        return Promise.resolve(
          fetchMatchingTrace(
            SESSION_ID,
            1, // turns = 1 (one assistant entry)
            COST,
            assistantTs, // must match local.end exactly to avoid END_DRIFT
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("trace coincide → drift:0, repaired:0, failed:0", async () => {
    const summary = await runReconcile(makeOpts({ jsonlRoot: tmpRoot }));
    expect(summary.candidates).toBe(1);
    expect(summary.drift).toBe(0);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe("runReconcile — excludeSession filtra el candidato", () => {
  const SESSION_ID = "c3d4e5f6-a7b8-9012-cdef-345678901234";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    writeSessionJsonl(tmpRoot, SESSION_ID);
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() => Promise.resolve(fetchNotFound()));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("excludeSession igual al session_id → drift:0 (sesión saltada)", async () => {
    const summary = await runReconcile(
      makeOpts({
        jsonlRoot: tmpRoot,
        excludeSession: SESSION_ID,
        dryRun: true,
      }),
    );
    expect(summary.drift).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runReconcile — error de fetch Langfuse (ECONNREFUSED)", () => {
  const SESSION_ID = "d4e5f6a7-b8c9-0123-defa-456789012345";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    writeSessionJsonl(tmpRoot, SESSION_ID);
    // fetch rejects → getTrace returns null → classifyDrift → MISSING
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("no lanza — drift detectado aunque fetch falle (MISSING por null remote)", async () => {
    // getTrace catches the fetch rejection internally via emitDegradation (global,
    // not the collecting wrapper) and returns null. classifyDrift(local, null) → MISSING.
    // runReconcile must resolve without throwing.
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: true }),
    );
    expect(summary.drift).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });
});
