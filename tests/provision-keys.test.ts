/**
 * Unit tests para scripts/provision-keys.ts
 *
 * Cubre las funciones puras (`WORKLOADS`, `buildKeyPayload`) que construyen
 * el contrato HTTP contra LiteLLM, más subprocess integration tests (dry-run,
 * missing key, mock-server create/skip/error, atomic write).
 *
 * Por qué importa: si `WORKLOADS[0].soft_budget` se cambia de 50 a 5 sin querer,
 * un dev podría disparar el budget en horas. Este test es el guard.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKLOADS, buildKeyPayload } from "../scripts/provision-keys";

describe("WORKLOADS — virtual keys de producción (2026-05-10)", () => {
  test("expone exactamente los aliases orvian-prod y atalaya-prod", () => {
    const aliases = WORKLOADS.map((w) => w.key_alias).toSorted();
    expect(aliases).toEqual(["atalaya-prod", "orvian-prod"]);
  });

  test("orvian-prod tiene los límites comprometidos al equipo", () => {
    const orvian = WORKLOADS.find((w) => w.key_alias === "orvian-prod");
    expect(orvian).toBeDefined();
    expect(orvian!.soft_budget).toBe(50);
    expect(orvian!.budget_duration).toBe("30d");
    expect(orvian!.tpm_limit).toBe(200_000);
    expect(orvian!.rpm_limit).toBe(100);
    expect(orvian!.metadata.workload).toBe("orvian");
    expect(orvian!.metadata.env).toBe("prod");
    expect(orvian!.models).toEqual(["claude-sonnet-4-6"]);
  });

  test("atalaya-prod tiene los límites comprometidos al equipo", () => {
    const atalaya = WORKLOADS.find((w) => w.key_alias === "atalaya-prod");
    expect(atalaya).toBeDefined();
    expect(atalaya!.soft_budget).toBe(20);
    expect(atalaya!.budget_duration).toBe("30d");
    expect(atalaya!.tpm_limit).toBe(100_000);
    expect(atalaya!.rpm_limit).toBe(50);
    expect(atalaya!.metadata.workload).toBe("atalaya");
    expect(atalaya!.metadata.env).toBe("prod");
    expect(atalaya!.models).toEqual(["claude-sonnet-4-6"]);
  });

  test("todos los workloads usan modelo del MODEL_PRICING central (I-6)", async () => {
    const { MODEL_PRICING } = await import("../shared/model-pricing");
    const known = new Set(Object.keys(MODEL_PRICING));
    for (const wl of WORKLOADS) {
      for (const model of wl.models) {
        // claude-sonnet-4-6 → matchea "claude-sonnet-4" via substring
        const hasMatch = [...known].some(
          (key) => key !== "default" && model.includes(key),
        );
        expect(hasMatch).toBe(true);
      }
    }
  });
});

describe("buildKeyPayload — contrato POST /key/generate", () => {
  const sample = WORKLOADS[0]!;

  test("incluye los 7 campos requeridos por LiteLLM", () => {
    const payload = buildKeyPayload(sample);
    expect(payload).toHaveProperty("key_alias");
    expect(payload).toHaveProperty("soft_budget");
    expect(payload).toHaveProperty("budget_duration");
    expect(payload).toHaveProperty("tpm_limit");
    expect(payload).toHaveProperty("rpm_limit");
    expect(payload).toHaveProperty("metadata");
    expect(payload).toHaveProperty("models");
  });

  test("NO incluye max_budget (M3 decision — soft enforcement only)", () => {
    const payload = buildKeyPayload(sample);
    expect(payload).not.toHaveProperty("max_budget");
  });

  test("preserva valores numéricos sin coerción a string", () => {
    const payload = buildKeyPayload(sample) as Record<string, unknown>;
    expect(typeof payload["soft_budget"]).toBe("number");
    expect(typeof payload["tpm_limit"]).toBe("number");
    expect(typeof payload["rpm_limit"]).toBe("number");
    // No empty strings, no string-numbers
    expect(payload["soft_budget"]).not.toBe("50");
  });

  test("payload serializa a JSON válido", () => {
    const payload = buildKeyPayload(sample);
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["key_alias"]).toBe(sample.key_alias);
    expect(parsed["soft_budget"]).toBe(sample.soft_budget);
  });

  test("metadata es un objeto plano serializable", () => {
    const payload = buildKeyPayload(sample) as { metadata: unknown };
    expect(payload.metadata).toEqual(sample.metadata);
    // Verifica que sobrevive un round-trip JSON sin perder propiedades
    const round = JSON.parse(JSON.stringify(payload.metadata)) as {
      workload: string;
      env: string;
    };
    expect(round.workload).toBe(sample.metadata.workload);
    expect(round.env).toBe(sample.metadata.env);
  });
});

// ─── Subprocess helpers ───────────────────────────────────────────────────────

const PROVISION_PATH = join(import.meta.dir, "../scripts/provision-keys.ts");

async function runProvision(
  env: Record<string, string>,
  home?: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", PROVISION_PATH], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LITELLM_MASTER_KEY: "sk-test-master-key",
      LITELLM_HOST: "http://127.0.0.1:19999", // intentionally unreachable
      ...env,
      ...(home ? { HOME: home } : {}),
    },
    cwd: join(import.meta.dir, ".."),
  });
  await Promise.race([
    proc.exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("runProvision timed out")), 15_000),
    ),
  ]);
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode ?? -1, stderr };
}

// ─── DRY_RUN=1 mode ──────────────────────────────────────────────────────────

describe("provision-keys subprocess — DRY_RUN=1", () => {
  test("exits 0 in dry-run mode", async () => {
    const { exitCode } = await runProvision({ DRY_RUN: "1" });
    expect(exitCode).toBe(0);
  });

  test("logs DRY_RUN hint and both workload aliases", async () => {
    const { stderr } = await runProvision({ DRY_RUN: "1" });
    expect(stderr).toContain("DRY_RUN=1");
    expect(stderr).toContain("orvian-prod");
    expect(stderr).toContain("atalaya-prod");
  });

  test("completes quickly — no network calls in dry-run mode", async () => {
    const start = Date.now();
    const { exitCode } = await runProvision({ DRY_RUN: "1" });
    const elapsed = Date.now() - start;
    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ─── Missing master key ───────────────────────────────────────────────────────

describe("provision-keys subprocess — missing LITELLM_MASTER_KEY", () => {
  test("exits 1 and mentions the missing var", async () => {
    const proc = Bun.spawn(["bun", "run", PROVISION_PATH], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir() },
      cwd: join(import.meta.dir, ".."),
    });
    await Promise.race([
      proc.exited,
      new Promise<never>((_, r) =>
        setTimeout(() => r(new Error("timeout")), 10_000),
      ),
    ]);
    const stderr = await new Response(proc.stderr).text();
    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("LITELLM_MASTER_KEY");
  });
});

// ─── Mock LiteLLM server ──────────────────────────────────────────────────────

describe("provision-keys subprocess — mock LiteLLM server", () => {
  let mockServer: ReturnType<typeof Bun.serve>;
  let mockPort: number;
  let tempHome: string;
  let requestLog: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(() => {
    requestLog = [];
    tempHome = mkdtempSync(join(tmpdir(), "atlax-provision-test-"));

    mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        let body: unknown = null;
        try {
          body = await req.json();
        } catch {
          /* no body */
        }
        requestLog.push({ method: req.method, path: url.pathname, body });

        if (url.pathname === "/key/list") {
          return new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/key/generate") {
          return new Response(
            JSON.stringify({ key: "sk-generated-test-key-abc123" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    mockPort = mockServer.port!;
  });

  afterEach(() => {
    mockServer.stop(true);
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function spawnProvision(extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", "run", PROVISION_PATH], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LITELLM_MASTER_KEY: "sk-master-test",
        LITELLM_HOST: `http://127.0.0.1:${mockPort}`,
        HOME: tempHome,
        ...extraEnv,
      },
      cwd: join(import.meta.dir, ".."),
    });
    await Promise.race([
      proc.exited,
      new Promise<never>((_, r) =>
        setTimeout(() => r(new Error("timeout")), 15_000),
      ),
    ]);
    const stderr = await new Response(proc.stderr).text();
    return { exitCode: proc.exitCode ?? -1, stderr };
  }

  test("creates both keys and writes virtual-keys.json", async () => {
    const { exitCode, stderr } = await spawnProvision();

    expect(exitCode).toBe(0);
    expect(stderr).toContain("OK    orvian-prod");
    expect(stderr).toContain("OK    atalaya-prod");

    const keyFilePath = join(tempHome, ".atlax-ai", "virtual-keys.json");
    const keyFile = JSON.parse(readFileSync(keyFilePath, "utf-8")) as {
      keys: Array<{ key_alias: string; key: string }>;
    };
    expect(keyFile.keys.length).toBe(2);
    expect(keyFile.keys.map((k) => k.key_alias).toSorted()).toEqual([
      "atalaya-prod",
      "orvian-prod",
    ]);
    expect(keyFile.keys[0]!.key).toMatch(/^sk-/);
  });

  test("skips existing alias and only creates the missing one", async () => {
    mockServer.stop(true);
    requestLog = [];
    mockServer = Bun.serve({
      port: mockPort,
      async fetch(req) {
        const url = new URL(req.url);
        let body: unknown = null;
        try {
          body = await req.json();
        } catch {
          /* no body */
        }
        requestLog.push({ method: req.method, path: url.pathname, body });

        if (url.pathname === "/key/list") {
          return new Response(
            JSON.stringify({ keys: [{ key_alias: "orvian-prod" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/key/generate") {
          return new Response(JSON.stringify({ key: "sk-new-atalaya" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });

    const { exitCode, stderr } = await spawnProvision();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("SKIP  orvian-prod");
    expect(stderr).toContain("OK    atalaya-prod");

    const generateCalls = requestLog.filter((r) => r.path === "/key/generate");
    expect(generateCalls.length).toBe(1);
    expect(
      (generateCalls[0]!.body as Record<string, unknown>)["key_alias"],
    ).toBe("atalaya-prod");
  });

  test("exits 2 when key/generate returns 500", async () => {
    mockServer.stop(true);
    requestLog = [];
    mockServer = Bun.serve({
      port: mockPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/key/list") {
          return new Response(JSON.stringify({ keys: [] }), { status: 200 });
        }
        if (url.pathname === "/key/generate") {
          return new Response("server error", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      },
    });

    const { exitCode, stderr } = await spawnProvision();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("ERROR");
  });

  test("no .tmp file left after successful write (atomic rename)", async () => {
    await spawnProvision();

    const keyFilePath = join(tempHome, ".atlax-ai", "virtual-keys.json");
    const tmpPath = `${keyFilePath}.tmp`;

    const content = JSON.parse(readFileSync(keyFilePath, "utf-8"));
    expect(content).toHaveProperty("keys");

    let tmpExists = false;
    try {
      readFileSync(tmpPath);
      tmpExists = true;
    } catch {
      /* expected — .tmp was renamed away */
    }
    expect(tmpExists).toBe(false);
  });
});
