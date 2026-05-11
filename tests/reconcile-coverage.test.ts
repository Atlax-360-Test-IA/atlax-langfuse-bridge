/**
 * tests/reconcile-coverage.test.ts
 *
 * Targets the low-coverage branches of scripts/reconcile-traces.ts that are
 * not reachable via reconcile-main.test.ts:
 *
 *   lines 573-575  — SAFE_SID_RE guard: SIDs with dots are skipped
 *   lines 621-624  — cwd-missing guard: drift without cwd increments failed
 *   lines 595-597  — second classifyDrift via getGenerationCost (cost > 0.01)
 *   lines 541-549, 643-651, 260-348 — ANTHROPIC_ADMIN_API_KEY opt-in path
 *
 * All env vars are saved/restored via I-12 helpers. Fetch is spied on
 * globalThis so no network calls escape.
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
  "ANTHROPIC_ADMIN_API_BASE",
];
const SAVED = saveEnv(ENV_KEYS);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpts(
  overrides: Partial<ReconcileOpts> & { jsonlRoot: string },
): ReconcileOpts {
  return {
    windowHours: 8760,
    dryRun: false,
    langfuseHost: "http://localhost:3000",
    publicKey: "pk-test",
    secretKey: "sk-test",
    ...overrides,
  };
}

/** Minimal JSONL with one assistant turn so turns=1, cost>0. */
function writeSessionJsonl(
  dir: string,
  sessionId: string,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    omitCwd?: boolean;
  } = {},
): { path: string; assistantTs: string } {
  const projectDir = join(dir, "project-alpha");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const assistantTs = new Date().toISOString();

  const lines: string[] = [];
  if (!opts.omitCwd) {
    lines.push(
      JSON.stringify({
        type: "summary",
        timestamp: new Date().toISOString(),
        cwd: "/home/dev/project",
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "assistant",
      timestamp: assistantTs,
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        usage: {
          input_tokens: opts.inputTokens ?? 100,
          output_tokens: opts.outputTokens ?? 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: "standard",
        },
      },
    }),
  );
  writeFileSync(filePath, lines.join("\n"));
  return { path: filePath, assistantTs };
}

// ─── Suite 1: Invalid SID — dots in filename bypass SAFE_SID_RE ───────────────
// Lines 573-575: if (!SAFE_SID_RE.test(sid)) { log("warn"...); continue; }

describe("runReconcile — SID inválido (contiene puntos) es ignorado", () => {
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-sid-test-"));
    // Create a JSONL whose filename contains dots — SAFE_SID_RE /^[0-9a-zA-Z_-]{1,128}$/
    // will reject it. The file must exist so discoverRecentJsonls picks it up.
    const projectDir = join(tmpRoot, "project-alpha");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "invalid.sid.with.dots.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
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
    );
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 404 })),
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

  test("candidato con SID inválido → drift=0, failed=0, fetch no llamado", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: true }),
    );
    // The file is discovered (candidates >= 1 because discoverRecentJsonls finds it)
    // but the SID fails SAFE_SID_RE so it is skipped before any fetch.
    expect(summary.drift).toBe(0);
    expect(summary.failed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── Suite 2: cwd missing → failed++ (lines 621-624) ─────────────────────────
// drift detected (trace 404) but local.cwd is null → failed++, not repaired

describe("runReconcile — cwd ausente en JSONL → failed++", () => {
  const SESSION_ID = "e5f6a7b8-c9d0-1234-efab-567890123456";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-cwd-test-"));
    // Write JSONL without a cwd-bearing entry (omitCwd=true removes the summary line)
    writeSessionJsonl(tmpRoot, SESSION_ID, { omitCwd: true });
    // getTrace → 404 → MISSING drift
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      ),
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

  test("drift detectado sin cwd → failed:1, repaired:0", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: false }),
    );
    expect(summary.candidates).toBe(1);
    expect(summary.drift).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(1);
  });

  test("dryRun=true con cwd ausente → repaired:0, failed:0 (no intenta reparar)", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: true }),
    );
    expect(summary.drift).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

// ─── Suite 3: Second classifyDrift via getGenerationCost (lines 595-597) ──────
// When status=OK but totalCost > 0.01, a second check fetches observations

describe("runReconcile — segundo classifyDrift via getGenerationCost", () => {
  // haiku-4-5 pricing: $1/$5 per MTok
  // 15000 input tokens → 15000/1_000_000 * 1 = 0.015 USD > 0.01 threshold
  const SESSION_ID = "f6a7b8c9-d0e1-2345-fabc-678901234567";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let assistantTs: string;
  let capturedUrls: string[];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-gencost-test-"));
    capturedUrls = [];
    // Large token count to push totalCost > 0.01
    ({ assistantTs } = writeSessionJsonl(tmpRoot, SESSION_ID, {
      inputTokens: 15_000,
      outputTokens: 100,
    }));

    // haiku-4-5: (15000 * 1 + 100 * 5) / 1_000_000 = 0.0155 USD
    const LOCAL_COST = 0.0155;

    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      capturedUrls.push(u);

      if (u.includes("/api/public/traces/")) {
        // Return a matching trace so first classifyDrift → OK
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: `cc-${SESSION_ID}`,
              metadata: {
                turns: 1,
                estimatedCostUSD: LOCAL_COST,
                sessionEnd: assistantTs,
              },
            }),
            { status: 200 },
          ),
        );
      }

      if (u.includes("/api/public/observations")) {
        // Return a generation observation with calculatedTotalCost matching local
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ calculatedTotalCost: LOCAL_COST }],
            }),
            { status: 200 },
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

  test("llama al endpoint /api/public/observations cuando totalCost > 0.01", async () => {
    await runReconcile(makeOpts({ jsonlRoot: tmpRoot, dryRun: true }));
    const observationsHit = capturedUrls.some((u) =>
      u.includes("/api/public/observations"),
    );
    expect(observationsHit).toBe(true);
  });

  test("cuando genCost coincide con estimado → drift:0", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: true }),
    );
    expect(summary.drift).toBe(0);
    expect(summary.repaired).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

// ─── Suite 4: ANTHROPIC_ADMIN_API_KEY opt-in (lines 541-549, 643-651, 260-348)
// reconcileCostAgainstAnthropic runs when ANTHROPIC_ADMIN_API_KEY is set

describe("runReconcile — ANTHROPIC_ADMIN_API_KEY activa reconcileCostAgainstAnthropic", () => {
  const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567891";
  let tmpRoot: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let capturedUrls: string[];
  let capturedHeaders: Record<string, string>[];
  let assistantTs: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-admin-test-"));
    capturedUrls = [];
    capturedHeaders = [];
    ({ assistantTs } = writeSessionJsonl(tmpRoot, SESSION_ID));

    // haiku-4-5: (100 * 1 + 50 * 5) / 1_000_000 = 0.00035 USD
    const LOCAL_COST = 0.00035;

    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(
      (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        capturedUrls.push(u);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedHeaders.push(headers);

        if (u.includes("/api/public/traces/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: `cc-${SESSION_ID}`,
                metadata: {
                  turns: 1,
                  estimatedCostUSD: LOCAL_COST,
                  sessionEnd: assistantTs,
                },
              }),
              { status: 200 },
            ),
          );
        }

        if (u.includes("/v1/organizations/cost_report")) {
          // Return a seat-only scenario (realUSD=0) so the function doesn't emit warns
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    results: [
                      {
                        currency: "USD",
                        amount: "0",
                        workspace_id: null,
                        description: "claude-haiku-4-5",
                        cost_type: "tokens",
                        model: "claude-haiku-4-5",
                      },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }

        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    );

    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    // Admin key must start with sk-ant-admin for the client to accept it
    process.env["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-admin01-test-key";
    // Redirect admin API calls to our fetch mock host
    process.env["ANTHROPIC_ADMIN_API_BASE"] = "http://localhost:3000";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("llama al endpoint /v1/organizations/cost_report cuando hay sesiones con modelos", async () => {
    await runReconcile(makeOpts({ jsonlRoot: tmpRoot, dryRun: false }));
    const adminHit = capturedUrls.some((u) =>
      u.includes("/v1/organizations/cost_report"),
    );
    expect(adminHit).toBe(true);
  });

  test("la URL de cost_report incluye group_by[]=description", async () => {
    await runReconcile(makeOpts({ jsonlRoot: tmpRoot, dryRun: false }));
    const costReportUrl = capturedUrls.find((u) =>
      u.includes("/v1/organizations/cost_report"),
    );
    expect(costReportUrl).toBeTruthy();
    expect(decodeURIComponent(costReportUrl as string)).toContain(
      "group_by[]=description",
    );
  });

  test("summary.degradations es un array (colector inicializado)", async () => {
    const summary = await runReconcile(
      makeOpts({ jsonlRoot: tmpRoot, dryRun: false }),
    );
    expect(Array.isArray(summary.degradations)).toBe(true);
  });

  test("sin ANTHROPIC_ADMIN_API_KEY no llama al endpoint cost_report", async () => {
    delete process.env["ANTHROPIC_ADMIN_API_KEY"];
    await runReconcile(makeOpts({ jsonlRoot: tmpRoot, dryRun: false }));
    const adminHit = capturedUrls.some((u) =>
      u.includes("/v1/organizations/cost_report"),
    );
    expect(adminHit).toBe(false);
  });
});
