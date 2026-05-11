#!/usr/bin/env bun
/**
 * provision-keys.ts — Provisioning idempotente de virtual keys LiteLLM
 * para los workloads Orvian y Atalaya.
 *
 * Idempotente: re-ejecutar es seguro — los aliases ya existentes se saltan.
 * Las claves generadas se guardan en ~/.atlax-ai/virtual-keys.json (fuera del repo).
 *
 * Requiere el gateway corriendo: docker compose --profile litellm up -d
 *
 * Variables (lee de ~/.atlax-ai/reconcile.env si no están en el entorno):
 *   LITELLM_MASTER_KEY  — master key del gateway (requerida)
 *   LITELLM_HOST        — URL del gateway (default: http://localhost:4001)
 *
 * Usage:
 *   bun run scripts/provision-keys.ts
 *   DRY_RUN=1 bun run scripts/provision-keys.ts   # preview sin crear keys
 */

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnvFile } from "../shared/env-loader";

// ─── Workload definitions ────────────────────────────────────────────────────

export interface WorkloadConfig {
  key_alias: string;
  soft_budget: number;
  budget_duration: string;
  tpm_limit: number;
  rpm_limit: number;
  metadata: { workload: string; env: string };
  models: string[];
}

export const WORKLOADS: WorkloadConfig[] = [
  {
    key_alias: "orvian-prod",
    soft_budget: 50.0,
    budget_duration: "30d",
    tpm_limit: 200_000,
    rpm_limit: 100,
    metadata: { workload: "orvian", env: "prod" },
    models: ["claude-sonnet-4-6"],
  },
  {
    key_alias: "atalaya-prod",
    soft_budget: 20.0,
    budget_duration: "30d",
    tpm_limit: 100_000,
    rpm_limit: 50,
    metadata: { workload: "atalaya", env: "prod" },
    models: ["claude-sonnet-4-6"],
  },
];

/**
 * Construye el body JSON exacto para POST /key/generate.
 * Pure function: testeable sin tocar HTTP.
 *
 * Sin `max_budget` por diseño (M3 PoC: solo enforcement soft, no hard stop).
 */
export function buildKeyPayload(wl: WorkloadConfig): Record<string, unknown> {
  return {
    key_alias: wl.key_alias,
    soft_budget: wl.soft_budget,
    budget_duration: wl.budget_duration,
    tpm_limit: wl.tpm_limit,
    rpm_limit: wl.rpm_limit,
    metadata: wl.metadata,
    models: wl.models,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[provision-keys] ${msg}\n`);
}

// ─── LiteLLM API calls ───────────────────────────────────────────────────────

export async function listExistingAliases(
  host: string,
  masterKey: string,
): Promise<Set<string>> {
  const res = await fetch(`${host}/key/list`, {
    headers: { Authorization: `Bearer ${masterKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    log(`WARN: GET /key/list returned ${res.status} — assuming no keys exist`);
    return new Set();
  }
  const data = (await res.json()) as {
    keys?: Array<{ key_alias?: string }>;
  };
  const aliases = new Set<string>();
  for (const k of data.keys ?? []) {
    if (k.key_alias) aliases.add(k.key_alias);
  }
  return aliases;
}

export async function createKey(
  host: string,
  masterKey: string,
  wl: WorkloadConfig,
): Promise<string> {
  const res = await fetch(`${host}/key/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${masterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildKeyPayload(wl)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /key/generate ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { key: string };
  if (!data.key) throw new Error("Response missing 'key' field");
  return data.key;
}

// ─── Output file ─────────────────────────────────────────────────────────────

export interface KeyRecord {
  key_alias: string;
  key: string;
  soft_budget: number;
  budget_duration: string;
  workload: string;
  env: string;
  skipped?: boolean;
}

export interface ProvisionOpts {
  host: string;
  masterKey: string;
  dryRun: boolean;
  /** Override output dir — defaults to ~/.atlax-ai. Used by tests. */
  outputDir?: string;
}

export interface ProvisionSummary {
  created: number;
  skipped: number;
  errors: number;
  results: KeyRecord[];
}

export function writeKeyFile(
  host: string,
  keys: KeyRecord[],
  outputDir?: string,
): void {
  const dir = outputDir ?? join(homedir(), ".atlax-ai");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "virtual-keys.json");
  const tmpPath = `${outPath}.tmp`;
  const content = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      litellm_host: host,
      keys: keys.map(({ skipped: _skip, ...k }) => k),
    },
    null,
    2,
  );
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, outPath); // atomic write
  log(`Keys saved → ${outPath}`);
}

// ─── runProvision / Main ──────────────────────────────────────────────────────

export async function runProvision(
  opts: ProvisionOpts,
): Promise<ProvisionSummary> {
  const { host, masterKey, dryRun, outputDir } = opts;

  if (dryRun) log("DRY_RUN=1 — no keys will be created or saved");

  log(`Target: ${host}`);
  log("Fetching existing keys...");

  const existing = dryRun
    ? new Set<string>()
    : await listExistingAliases(host, masterKey);
  log(`Found ${existing.size} existing key(s)`);

  const results: KeyRecord[] = [];
  let errors = 0;

  for (const wl of WORKLOADS) {
    if (existing.has(wl.key_alias)) {
      log(`SKIP  ${wl.key_alias} — already exists`);
      results.push({
        key_alias: wl.key_alias,
        key: "sk-<existing-not-retrieved>",
        soft_budget: wl.soft_budget,
        budget_duration: wl.budget_duration,
        workload: wl.metadata.workload,
        env: wl.metadata.env,
        skipped: true,
      });
      continue;
    }

    if (dryRun) {
      log(
        `DRY   ${wl.key_alias} — would create (soft_budget=$${wl.soft_budget}/30d, tpm=${wl.tpm_limit}, rpm=${wl.rpm_limit})`,
      );
      continue;
    }

    try {
      const key = await createKey(host, masterKey, wl);
      // Don't log any prefix of the virtual key — even partial chars create
      // an unnecessary trail in journalctl/CI logs. Length is enough proof.
      log(`OK    ${wl.key_alias} — created (length=${key.length})`);
      results.push({
        key_alias: wl.key_alias,
        key,
        soft_budget: wl.soft_budget,
        budget_duration: wl.budget_duration,
        workload: wl.metadata.workload,
        env: wl.metadata.env,
      });
    } catch (err) {
      process.stderr.write(
        `[provision-keys] ERROR ${wl.key_alias}: ${(err as Error).message}\n`,
      );
      errors++;
    }
  }

  if (!dryRun && results.filter((r) => !r.skipped).length > 0) {
    writeKeyFile(host, results, outputDir);
  }

  const created = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  log(`Done — created: ${created}, skipped: ${skipped}, errors: ${errors}`);

  return { created, skipped, errors, results };
}

async function main(): Promise<void> {
  loadEnvFile();

  const host = (process.env["LITELLM_HOST"] ?? "http://localhost:4001").replace(
    /\/$/,
    "",
  );
  const masterKey = process.env["LITELLM_MASTER_KEY"];
  const dryRun = process.env["DRY_RUN"] === "1";

  if (!masterKey) {
    process.stderr.write("[provision-keys] LITELLM_MASTER_KEY not set\n");
    process.exit(1);
  }

  const summary = await runProvision({ host, masterKey, dryRun });
  if (summary.errors > 0) process.exit(2);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    process.stderr.write(`[provision-keys] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
