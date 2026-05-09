/**
 * Fase D — enforcement: paths de código referenciados en ARCHITECTURE.md existen en disco.
 * Previene drift entre la documentación y el código cuando se renombran módulos.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SDD_PATH = join(REPO_ROOT, "ARCHITECTURE.md");

/**
 * Paths explícitos que ARCHITECTURE.md garantiza que existen.
 * Se derivan de las tablas §4 (shared/, scripts/, tests/) y del §2 (infra/).
 * Se mantienen aquí en lugar de parsear el markdown para ser deterministas
 * y evitar falsos positivos por fragmentos de código inline.
 */
const REQUIRED_PATHS: Array<{ path: string; section: string }> = [
  // §2 · Stack
  { path: "infra/cloud-run.yaml", section: "§2 Stack" },

  // §4 · shared/ modules
  { path: "shared/model-pricing.ts", section: "§4 shared/ I-6" },
  { path: "shared/aggregate.ts", section: "§4 shared/ I-3" },
  { path: "shared/drift.ts", section: "§4 shared/ I-11" },
  { path: "shared/langfuse-client.ts", section: "§4 shared/" },
  { path: "shared/hash-cache.ts", section: "§4 shared/" },
  { path: "shared/degradation.ts", section: "§4 shared/" },
  { path: "shared/constants.ts", section: "§4 shared/" },
  { path: "shared/env-loader.ts", section: "§4 shared/" },
  { path: "shared/jsonl-discovery.ts", section: "§4 shared/ edge" },
  { path: "shared/processing-tiers.ts", section: "§4 shared/" },
  { path: "shared/tools/registry.ts", section: "§13 P-4 registry" },
  { path: "shared/tools/adapters/mcp-adapter.ts", section: "§13 P-4 adapters" },
  { path: "shared/tools/adapters/zod-adapter.ts", section: "§13 P-4 adapters" },

  // §4 · scripts/
  { path: "scripts/validate-traces.ts", section: "§4 scripts/" },
  { path: "scripts/reconcile-traces.ts", section: "§4 scripts/" },
  { path: "scripts/detect-tier.ts", section: "§4 scripts/" },
  { path: "scripts/mcp-server.ts", section: "§4 scripts/" },
  { path: "scripts/provision-keys.ts", section: "§4 scripts/" },
  { path: "scripts/smoke-mcp-e2e.ts", section: "§4 scripts/" },
  { path: "scripts/statusline.sh", section: "§8 statusline" },

  // §4 · hooks/
  { path: "hooks/langfuse-sync.ts", section: "§4 hooks/ I-1" },

  // §10 · tests/ mapeo invariantes
  { path: "tests/langfuse-sync-http.test.ts", section: "§10 I-1" },
  { path: "tests/e2e-pipeline.test.ts", section: "§10 I-2/I-3" },
  { path: "tests/reconcile-replay.test.ts", section: "§10 I-5" },
  { path: "tests/extension-pricing.test.ts", section: "§10 I-6" },
  { path: "scripts/detect-tier.test.ts", section: "§10 I-7/I-8" },
  { path: "scripts/mcp-server.test.ts", section: "§10 I-10" },
  { path: "shared/drift.test.ts", section: "§10 I-11" },
  { path: "tests/cross-validation.test.ts", section: "§10 I-12" },
  { path: "tests/cloud-run-boundary.test.ts", section: "§10 I-13" },

  // §6 · CI/CD
  { path: "setup/setup.sh", section: "§6 deploy" },

  // Top-level docs
  { path: "ARCHITECTURE.md", section: "§4 map" },
  { path: "CHANGELOG.md", section: "§6 semver" },
  { path: "ORGANIZATION.md", section: "§4 map" },
  { path: "README.md", section: "§4 map" },
  { path: "CLAUDE.md", section: "§4 map" },
  { path: "docs/operations/runbook.md", section: "§4 map" },
  { path: "infra/backup-story.md", section: "§9 PRO + §12 GAP-P02" },

  // Shared Platform alignment (PR #73)
  {
    path: "docs/audits/shared-platform-validation-2026-05-09.md",
    section: "§9 PRO — audit Shared Platform v0.3",
  },
  {
    path: "scripts/ops/PRO_ENV_VARS.md",
    section: "§8 env vars — inventario formal",
  },
  { path: "infra/provision-pro.sh", section: "§9 PRO provisioning" },
  {
    path: "docs/operations/cloud-run-deployment-plan.md",
    section: "§9 PRO plan F1-F5",
  },

  // docker
  { path: "docker/docker-compose.yml", section: "§2 Stack / §14 R-3" },
];

let sdd: string;

beforeAll(() => {
  sdd = readFileSync(SDD_PATH, "utf-8");
});

describe("ARCHITECTURE.md — paths referenciados existen en disco", () => {
  for (const { path: relPath, section } of REQUIRED_PATHS) {
    it(`${relPath} (referenciado en ${section})`, () => {
      const abs = join(REPO_ROOT, relPath);
      expect(
        existsSync(abs),
        `Fichero referenciado en ARCHITECTURE.md no existe: ${relPath}`,
      ).toBe(true);
    });
  }

  it("ARCHITECTURE.md no está vacío", () => {
    expect(sdd.length).toBeGreaterThan(5000);
  });
});
