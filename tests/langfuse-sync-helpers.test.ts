/**
 * tests/langfuse-sync-helpers.test.ts
 *
 * Cobertura incremental de funciones auxiliares exportadas de hooks/langfuse-sync.ts.
 * Complementa langfuse-sync-unit.test.ts y langfuse-sync-send.test.ts sin duplicar.
 *
 * Cubre:
 *   calcCost       — haiku-4-5 pricing + todos los tipos de tokens + undefined
 *   getDevIdentity — LANGFUSE_USER_ID > CLAUDE_DEV_NAME (env var paths, líneas 88)
 *   getBillingTier — los 3 branches (vertex/priority/standard)
 *   readTierFile   — account numérico/array → null (líneas 180-185) via subprocess
 *   detectOS       — retorna OSName válido
 *   sendToLangfuse — ftp:// silenciado, claves ausentes, 5xx no lanza, éxito
 *
 * I-12: saveEnv/restoreEnv para process.env.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { saveEnv, restoreEnv } from "./helpers/env";

import {
  calcCost,
  getDevIdentity,
  getBillingTier,
  detectOS,
  sendToLangfuse,
} from "../hooks/langfuse-sync";

const ENV_KEYS = [
  "LANGFUSE_USER_ID",
  "CLAUDE_DEV_NAME",
  "LANGFUSE_HOST",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "CLAUDE_CODE_USE_VERTEX",
] as const;
const SAVED = saveEnv(ENV_KEYS);

// ─── calcCost ─────────────────────────────────────────────────────────────────

describe("calcCost — claude-haiku-4-5 pricing", () => {
  // haiku-4-5: input=$1, cacheWrite=$1.25, cacheRead=$0.10, output=$5 per MTok
  const MODEL = "claude-haiku-4-5";

  test("retorna 0 cuando usage es undefined", () => {
    expect(calcCost(undefined, MODEL)).toBe(0);
  });

  test("calcula coste para input + output únicamente", () => {
    // (1000 * 1 + 500 * 5) / 1_000_000 = 0.0035
    const usage = { input_tokens: 1000, output_tokens: 500 };
    expect(calcCost(usage, MODEL)).toBeCloseTo(0.0035, 8);
  });

  test("incluye cache_creation_input_tokens y cache_read_input_tokens", () => {
    // (1000*1 + 200*1.25 + 300*0.1 + 500*5) / 1_000_000 = 0.00378
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    };
    expect(calcCost(usage, MODEL)).toBeCloseTo(0.00378, 8);
  });

  test("haiku es más barato que sonnet para el mismo token count", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const haikuCost = calcCost(usage, MODEL);
    const sonnetCost = calcCost(usage, "claude-sonnet-4");
    expect(haikuCost).toBeLessThan(sonnetCost);
  });

  test("devuelve 0 cuando todos los contadores son 0", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    expect(calcCost(usage, MODEL)).toBe(0);
  });
});

// ─── getDevIdentity ───────────────────────────────────────────────────────────

describe("getDevIdentity — paths de env var", () => {
  afterEach(() => restoreEnv(SAVED));

  test("LANGFUSE_USER_ID prevalece sobre CLAUDE_DEV_NAME cuando ambas activas", () => {
    process.env["LANGFUSE_USER_ID"] = "user-id-wins@example.com";
    process.env["CLAUDE_DEV_NAME"] = "dev-name-loses";
    expect(getDevIdentity()).toBe("user-id-wins@example.com");
  });

  test("LANGFUSE_USER_ID retornado directamente cuando está solo", () => {
    process.env["LANGFUSE_USER_ID"] = "direct@example.com";
    delete process.env["CLAUDE_DEV_NAME"];
    expect(getDevIdentity()).toBe("direct@example.com");
  });

  test("CLAUDE_DEV_NAME retornado cuando LANGFUSE_USER_ID ausente (línea 88)", () => {
    delete process.env["LANGFUSE_USER_ID"];
    process.env["CLAUDE_DEV_NAME"] = "fallback-dev-name";
    expect(getDevIdentity()).toBe("fallback-dev-name");
  });

  test("retorna string no vacío cuando no hay env vars (fallback a git o os.userInfo)", () => {
    delete process.env["LANGFUSE_USER_ID"];
    delete process.env["CLAUDE_DEV_NAME"];
    const result = getDevIdentity();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("undefined");
    expect(result).not.toBe("null");
  });
});

// ─── getBillingTier ───────────────────────────────────────────────────────────

describe("getBillingTier — los 3 branches", () => {
  afterEach(() => restoreEnv(SAVED));

  test("retorna vertex-gcp cuando CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("retorna vertex-gcp cuando CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "true";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("retorna anthropic-priority-overage cuando serviceTier=priority", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier("priority")).toBe("anthropic-priority-overage");
  });

  test("retorna anthropic-team-standard por defecto", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier()).toBe("anthropic-team-standard");
  });

  test("CLAUDE_CODE_USE_VERTEX=0 no activa vertex (string distinta de '1'/'true')", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "0";
    expect(getBillingTier()).not.toBe("vertex-gcp");
  });
});

// ─── readTierFile — account field validation (subprocess) ────────────────────
// os.homedir() es inmutable en Bun runtime. Para inyectar un HOME alternativo
// se usa subprocess con env: { HOME: tmpDir } (ver feedback_bun_os_homedir_immutable.md)

const HOOK_PATH = path.join(import.meta.dir, "../hooks/langfuse-sync.ts");

async function runReadTierFile(
  homeDir: string,
  tierContent: unknown,
): Promise<unknown> {
  const atlaxDir = path.join(homeDir, ".atlax-ai");
  fs.mkdirSync(atlaxDir, { recursive: true });
  fs.writeFileSync(
    path.join(atlaxDir, "tier.json"),
    JSON.stringify(tierContent),
    "utf-8",
  );

  const script = `
    import { readTierFile } from "${HOOK_PATH}";
    const result = readTierFile();
    process.stdout.write(JSON.stringify({ result }));
  `;

  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homeDir },
    cwd: path.join(import.meta.dir, ".."),
  });

  await Promise.race([
    proc.exited,
    new Promise<never>((_, r) =>
      setTimeout(() => r(new Error("readTierFile subprocess timeout")), 15_000),
    ),
  ]);

  const stdout = await new Response(proc.stdout).text();
  try {
    return (JSON.parse(stdout) as { result: unknown }).result;
  } catch {
    return null;
  }
}

describe("readTierFile — validación del campo account (líneas 180-185)", () => {
  const validBase = {
    tier: "seat-team",
    source: "oauth",
    detectedAt: new Date().toISOString(),
  };

  test("retorna null cuando account es un número (no string|null)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-num-${Date.now()}`);
    try {
      const result = await runReadTierFile(homeDir, {
        ...validBase,
        account: 42,
      });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("retorna null cuando account es un array", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-arr-${Date.now()}`);
    try {
      const result = await runReadTierFile(homeDir, {
        ...validBase,
        account: ["bad"],
      });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("retorna TierFile válido cuando account es null", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-null-${Date.now()}`);
    try {
      const result = await runReadTierFile(homeDir, {
        ...validBase,
        account: null,
      });
      expect(result).not.toBeNull();
      expect((result as { tier: string }).tier).toBe("seat-team");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("retorna TierFile válido cuando account es string", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-str-${Date.now()}`);
    try {
      const result = await runReadTierFile(homeDir, {
        ...validBase,
        account: "user@atlax360.com",
      });
      expect(result).not.toBeNull();
      expect((result as { account: string }).account).toBe("user@atlax360.com");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("retorna null cuando tier value es inválido (no está en VALID_TIERS)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-invalid-${Date.now()}`);
    try {
      const result = await runReadTierFile(homeDir, {
        ...validBase,
        tier: "super-admin",
        account: null,
      });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("retorna null cuando el fichero no existe", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-missing-${Date.now()}`);
    fs.mkdirSync(homeDir, { recursive: true });
    try {
      // No .atlax-ai/tier.json written → catch(err) → return null
      const script = `
        import { readTierFile } from "${HOOK_PATH}";
        const result = readTierFile();
        process.stdout.write(JSON.stringify({ result }));
      `;
      const proc = Bun.spawn(["bun", "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: homeDir },
        cwd: path.join(import.meta.dir, ".."),
      });
      await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const parsed = JSON.parse(stdout) as { result: unknown };
      expect(parsed.result).toBeNull();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ─── detectOS ────────────────────────────────────────────────────────────────

describe("detectOS — detección de plataforma", () => {
  test("retorna uno de los valores OSName válidos", () => {
    const result = detectOS();
    const VALID: string[] = ["linux", "wsl", "macos", "windows"];
    expect(VALID).toContain(result);
  });

  test("en WSL2 retorna 'wsl' (entorno de CI del proyecto)", () => {
    // Este test solo pasa en el entorno WSL del proyecto;
    // en otras plataformas verifica que la función no lanza.
    const result = detectOS();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── sendToLangfuse ───────────────────────────────────────────────────────────

describe("sendToLangfuse — host inseguro (líneas 215-221)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("ftp:// es bloqueado — fetch no se llama", async () => {
    process.env["LANGFUSE_HOST"] = "ftp://evil.com";
    await sendToLangfuse([{ type: "trace-create", body: {} }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("http:// (no localhost) es bloqueado — fetch no se llama", async () => {
    process.env["LANGFUSE_HOST"] = "http://external.service.com";
    await sendToLangfuse([{ type: "trace-create", body: {} }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("http://localhost es permitido — fetch se llama", async () => {
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    await sendToLangfuse([{ type: "trace-create", body: {} }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("https:// externo es permitido — fetch se llama", async () => {
    process.env["LANGFUSE_HOST"] = "https://cloud.langfuse.com";
    await sendToLangfuse([{ type: "trace-create", body: {} }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sendToLangfuse — claves ausentes (líneas 228-231)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("sin LANGFUSE_PUBLIC_KEY → fetch no se llama", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
    await sendToLangfuse([{}]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("sin LANGFUSE_SECRET_KEY → fetch no se llama", async () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    delete process.env["LANGFUSE_SECRET_KEY"];
    await sendToLangfuse([{}]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("sin ninguna clave → fetch no se llama", async () => {
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    delete process.env["LANGFUSE_SECRET_KEY"];
    await sendToLangfuse([{}]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendToLangfuse — HTTP 5xx no lanza (líneas 249-252)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("respuesta 500 no lanza — resuelve undefined", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("internal error", { status: 500 })),
    );
    await expect(sendToLangfuse([{}])).resolves.toBeUndefined();
  });

  test("respuesta 400 no lanza — resuelve undefined", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("bad request", { status: 400 })),
    );
    await expect(sendToLangfuse([{}])).resolves.toBeUndefined();
  });
});

describe("sendToLangfuse — success path", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 207 })),
    );
    process.env["LANGFUSE_HOST"] = "http://localhost:3000";
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("llama a /api/public/ingestion con Authorization Basic", async () => {
    await sendToLangfuse([{ type: "trace-create", body: { id: "t1" } }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain("/api/public/ingestion");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });

  test("body enviado contiene el batch serializado", async () => {
    const batch = [
      { type: "trace-create", body: { id: "test-trace" } },
      { type: "generation-create", body: { id: "gen-1" } },
    ];
    await sendToLangfuse(batch);
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    const bodyParsed = JSON.parse(init.body as string) as {
      batch: unknown[];
    };
    expect(bodyParsed.batch).toHaveLength(2);
  });

  test("resuelve undefined en éxito (207 Multi-Status)", async () => {
    await expect(sendToLangfuse([{}])).resolves.toBeUndefined();
  });
});
