/**
 * tests/provision-keys-unit.test.ts
 *
 * Unit tests para las funciones exportadas de scripts/provision-keys.ts:
 *   - listExistingAliases
 *   - createKey
 *   - writeKeyFile
 *   - runProvision
 *
 * Estrategia:
 * - spyOn(globalThis, "fetch") para controlar respuestas HTTP sin red real.
 * - outputDir apuntando a tmpdir para aislar writeKeyFile de ~/.atlax-ai.
 * - Verificar: created/skipped/errors correctos, escritura atómica (sin .tmp
 *   leftover), no-write si 0 creadas, dryRun sin fetch calls.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv, restoreEnv } from "./helpers/env";
import {
  listExistingAliases,
  createKey,
  writeKeyFile,
  runProvision,
  WORKLOADS,
  type KeyRecord,
  type WorkloadConfig,
} from "../scripts/provision-keys";

const ENV_KEYS = ["LITELLM_MASTER_KEY", "LITELLM_HOST", "DRY_RUN"];
const SAVED = saveEnv(ENV_KEYS);

// ─── listExistingAliases ──────────────────────────────────────────────────────

describe("listExistingAliases", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("devuelve Set vacío cuando /key/list responde sin keys", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      ),
    );
    const aliases = await listExistingAliases("http://localhost:4001", "mk");
    expect(aliases.size).toBe(0);
  });

  test("devuelve Set con los aliases existentes", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [
              { key_alias: "orvian-prod" },
              { key_alias: "atalaya-prod" },
              { key_alias: "other-key" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const aliases = await listExistingAliases("http://localhost:4001", "mk");
    expect(aliases.has("orvian-prod")).toBe(true);
    expect(aliases.has("atalaya-prod")).toBe(true);
    expect(aliases.has("other-key")).toBe(true);
    expect(aliases.size).toBe(3);
  });

  test("ignora entradas sin key_alias (no lanza)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [{ key_alias: "valid-alias" }, {}, { key_alias: null }],
          }),
          { status: 200 },
        ),
      ),
    );
    const aliases = await listExistingAliases("http://localhost:4001", "mk");
    expect(aliases.has("valid-alias")).toBe(true);
    expect(aliases.size).toBe(1);
  });

  test("devuelve Set vacío si /key/list falla con 4xx (WARN, no lanza)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    const aliases = await listExistingAliases(
      "http://localhost:4001",
      "bad-key",
    );
    expect(aliases.size).toBe(0);
  });

  test("llama a /key/list con el header Authorization correcto", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      ),
    );
    await listExistingAliases("http://localhost:4001", "sk-master-xyz");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/key/list");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-master-xyz",
    );
  });
});

// ─── createKey ───────────────────────────────────────────────────────────────

describe("createKey", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const wl: WorkloadConfig = WORKLOADS[0]!;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("devuelve la key generada en respuesta 200", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ key: "sk-virtual-abc123" }), {
          status: 200,
        }),
      ),
    );
    const key = await createKey("http://localhost:4001", "mk", wl);
    expect(key).toBe("sk-virtual-abc123");
  });

  test("lanza si el servidor responde 500", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("server error", { status: 500 })),
    );
    await expect(createKey("http://localhost:4001", "mk", wl)).rejects.toThrow(
      "500",
    );
  });

  test("lanza si la respuesta no contiene campo 'key'", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "wrong-field" }), { status: 200 }),
      ),
    );
    await expect(createKey("http://localhost:4001", "mk", wl)).rejects.toThrow(
      "missing 'key'",
    );
  });

  test("llama a POST /key/generate con payload correcto", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ key: "sk-test" }), { status: 200 }),
      ),
    );
    await createKey("http://localhost:4001", "sk-master", wl);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/key/generate");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["key_alias"]).toBe(wl.key_alias);
    expect(body["soft_budget"]).toBe(wl.soft_budget);
    expect(body["tpm_limit"]).toBe(wl.tpm_limit);
    expect(body["rpm_limit"]).toBe(wl.rpm_limit);
  });
});

// ─── writeKeyFile ─────────────────────────────────────────────────────────────

describe("writeKeyFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provision-write-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleKeys: KeyRecord[] = [
    {
      key_alias: "orvian-prod",
      key: "sk-abc",
      soft_budget: 50,
      budget_duration: "30d",
      workload: "orvian",
      env: "prod",
    },
    {
      key_alias: "atalaya-prod",
      key: "sk-xyz",
      soft_budget: 20,
      budget_duration: "30d",
      workload: "atalaya",
      env: "prod",
    },
  ];

  test("crea virtual-keys.json en el outputDir indicado", () => {
    writeKeyFile("http://localhost:4001", sampleKeys, tmpDir);
    const outPath = join(tmpDir, "virtual-keys.json");
    expect(existsSync(outPath)).toBe(true);
  });

  test("JSON resultante tiene el shape correcto (generated_at, litellm_host, keys)", () => {
    writeKeyFile("http://localhost:4001", sampleKeys, tmpDir);
    const outPath = join(tmpDir, "virtual-keys.json");
    const content = JSON.parse(readFileSync(outPath, "utf-8")) as {
      generated_at: string;
      litellm_host: string;
      keys: Array<{ key_alias: string; key: string }>;
    };
    expect(typeof content.generated_at).toBe("string");
    expect(content.litellm_host).toBe("http://localhost:4001");
    expect(content.keys.length).toBe(2);
    expect(content.keys.map((k) => k.key_alias).toSorted()).toEqual([
      "atalaya-prod",
      "orvian-prod",
    ]);
  });

  test("campo 'skipped' NO aparece en el fichero (se omite en el output)", () => {
    const keysWithSkipped: KeyRecord[] = [
      { ...sampleKeys[0]!, skipped: false },
      { ...sampleKeys[1]!, skipped: true },
    ];
    writeKeyFile("http://localhost:4001", keysWithSkipped, tmpDir);
    const raw = readFileSync(join(tmpDir, "virtual-keys.json"), "utf-8");
    expect(raw).not.toContain("skipped");
  });

  test("no queda fichero .tmp tras escritura atómica correcta", () => {
    writeKeyFile("http://localhost:4001", sampleKeys, tmpDir);
    const tmpPath = join(tmpDir, "virtual-keys.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("overwrite: segunda escritura sobreescribe sin dejar .tmp", () => {
    writeKeyFile("http://localhost:4001", sampleKeys, tmpDir);
    const newKeys: KeyRecord[] = [{ ...sampleKeys[0]!, key: "sk-updated" }];
    writeKeyFile("http://localhost:4001", newKeys, tmpDir);
    const content = JSON.parse(
      readFileSync(join(tmpDir, "virtual-keys.json"), "utf-8"),
    ) as { keys: Array<{ key: string }> };
    expect(content.keys[0]!.key).toBe("sk-updated");
    expect(existsSync(join(tmpDir, "virtual-keys.json.tmp"))).toBe(false);
  });
});

// ─── runProvision ─────────────────────────────────────────────────────────────

describe("runProvision — dryRun=true", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    restoreEnv(SAVED);
  });

  test("no llama a fetch en dryRun", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("devuelve created:0, skipped:0, errors:0 en dryRun", async () => {
    const summary = await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: true,
    });
    expect(summary.created).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.results).toHaveLength(0);
  });
});

describe("runProvision — ambos workloads nuevos (created:2)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provision-run-test-"));
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/key/list")) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 }),
        );
      }
      if (u.includes("/key/generate")) {
        return Promise.resolve(
          new Response(JSON.stringify({ key: "sk-generated-key" }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("created:2, skipped:0, errors:0", async () => {
    const summary = await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("escribe virtual-keys.json en outputDir", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    const outPath = join(tmpDir, "virtual-keys.json");
    expect(existsSync(outPath)).toBe(true);
    const content = JSON.parse(readFileSync(outPath, "utf-8")) as {
      keys: Array<{ key_alias: string }>;
    };
    expect(content.keys.length).toBe(2);
  });

  test("llama a /key/list una vez y a /key/generate dos veces", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    const calls: string[] = fetchSpy.mock.calls.map((args: unknown[]) =>
      String(args[0]),
    );
    expect(calls.filter((u) => u.includes("/key/list")).length).toBe(1);
    expect(calls.filter((u) => u.includes("/key/generate")).length).toBe(2);
  });
});

describe("runProvision — ambos workloads ya existen (skipped:2)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provision-skip-test-"));
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      if (String(url).includes("/key/list")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              keys: [
                { key_alias: "orvian-prod" },
                { key_alias: "atalaya-prod" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("created:0, skipped:2, errors:0", async () => {
    const summary = await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    expect(summary.created).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toBe(0);
  });

  test("NO escribe virtual-keys.json si no hay created", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    const outPath = join(tmpDir, "virtual-keys.json");
    expect(existsSync(outPath)).toBe(false);
  });

  test("NO llama a /key/generate", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    const generateCalls = fetchSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("/key/generate"),
    );
    expect(generateCalls.length).toBe(0);
  });
});

describe("runProvision — servidor devuelve 500 en /key/generate", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provision-error-test-"));
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      if (String(url).includes("/key/list")) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 }),
        );
      }
      if (String(url).includes("/key/generate")) {
        return Promise.resolve(new Response("server error", { status: 500 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("errors:2, created:0, no lanza (catch interno)", async () => {
    const summary = await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    expect(summary.errors).toBe(2);
    expect(summary.created).toBe(0);
  });

  test("NO escribe virtual-keys.json si todos fallan", async () => {
    await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    const outPath = join(tmpDir, "virtual-keys.json");
    expect(existsSync(outPath)).toBe(false);
  });
});

describe("runProvision — uno creado uno fallado", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let tmpDir: string;
  let callCount: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provision-mixed-test-"));
    callCount = 0;
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      if (String(url).includes("/key/list")) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), { status: 200 }),
        );
      }
      if (String(url).includes("/key/generate")) {
        callCount++;
        // Primera llamada OK, segunda falla
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ key: "sk-first-ok" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("error", { status: 500 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(SAVED);
  });

  test("created:1, errors:1 — escribe fichero con la key creada", async () => {
    const summary = await runProvision({
      host: "http://localhost:4001",
      masterKey: "mk",
      dryRun: false,
      outputDir: tmpDir,
    });
    expect(summary.created).toBe(1);
    expect(summary.errors).toBe(1);

    const outPath = join(tmpDir, "virtual-keys.json");
    expect(existsSync(outPath)).toBe(true);
    const content = JSON.parse(readFileSync(outPath, "utf-8")) as {
      keys: Array<{ key: string }>;
    };
    expect(content.keys.length).toBe(1);
    expect(content.keys[0]!.key).toBe("sk-first-ok");
  });
});
