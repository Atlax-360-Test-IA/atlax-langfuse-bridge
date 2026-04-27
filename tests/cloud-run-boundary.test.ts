/**
 * Cloud Run boundary tests — enforces invariant I-13 from CLAUDE.md.
 *
 * The hook, reconciler, and discovery scripts depend on filesystem access
 * to ~/.claude/projects and ~/.atlax-ai. They are designed to run on the
 * developer's machine, NOT inside Cloud Run.
 *
 * These tests verify that:
 *  1. backup-langfuse.sh refuses to run when K_SERVICE is set (Cloud Run env var)
 *  2. The Langfuse client (which IS Cloud Run-compatible) accepts https://*.run.app
 *     hosts as valid LANGFUSE_HOST targets.
 *  3. The CLAUDE.md invariant I-13 text is present (regression guard against
 *     accidental deletion in a future doc refactor).
 *
 * If any of these fail, someone is about to break the edge/core split.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeHost } from "../shared/langfuse-client";

const REPO_ROOT = join(import.meta.dir, "..");

// ─── 1. backup-langfuse.sh refuses Cloud Run ─────────────────────────────────

describe("backup-langfuse.sh — Cloud Run guard", () => {
  test("refuses to run when K_SERVICE is set", async () => {
    const proc = Bun.spawn(
      ["bash", join(REPO_ROOT, "scripts", "backup-langfuse.sh")],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          K_SERVICE: "langfuse-web",
        },
      },
    );
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("Cloud Run");
  });

  test("refuses to run when KUBERNETES_SERVICE_HOST is set", async () => {
    const proc = Bun.spawn(
      ["bash", join(REPO_ROOT, "scripts", "backup-langfuse.sh")],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          KUBERNETES_SERVICE_HOST: "10.0.0.1",
        },
      },
    );
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("Cloud Run");
  });
});

// ─── 2. Cloud Run URLs are valid LANGFUSE_HOST targets ───────────────────────

describe("isSafeHost accepts Cloud Run URLs (PRO migration path)", () => {
  test("accepts https://langfuse-web-xxxxx-ew.a.run.app", () => {
    expect(isSafeHost("https://langfuse-web-abc123-ew.a.run.app")).toBe(true);
  });

  test("accepts custom domain over HTTPS", () => {
    expect(isSafeHost("https://langfuse.atlax360.com")).toBe(true);
  });

  test("rejects http://*.run.app (no TLS)", () => {
    expect(isSafeHost("http://langfuse-web-abc123-ew.a.run.app")).toBe(false);
  });
});

// ─── 3. CLAUDE.md + ARCHITECTURE.md document I-13 ────────────────────────────

describe("CLAUDE.md invariants", () => {
  const claudeMd = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");
  const architectureMd = readFileSync(
    join(REPO_ROOT, "ARCHITECTURE.md"),
    "utf-8",
  );

  test("invariant I-13 is documented in CLAUDE.md", () => {
    expect(claudeMd).toContain("I-13");
    expect(claudeMd).toContain("NUNCA migran a Cloud Run");
  });

  test("invariant I-13 lists the edge components in CLAUDE.md", () => {
    // The list of files that stay local — guard against partial deletions.
    expect(claudeMd).toContain("scripts/reconcile-traces.ts");
    expect(claudeMd).toContain("hooks/langfuse-sync.ts");
    expect(claudeMd).toContain("~/.atlax-ai");
    expect(claudeMd).toContain("~/.claude/projects");
  });

  test("ARCHITECTURE.md §4 documents edge/core split", () => {
    // After SDD migration, the edge/core topology lives in ARCHITECTURE.md §4
    // (was in CLAUDE.md "Stack" section pre-Fase B).
    expect(architectureMd).toContain("edge");
    expect(architectureMd).toContain("core");
    expect(architectureMd).toContain("máquina del dev");
  });
});

// ─── 4. infra/cloud-run.yaml is present and well-formed ──────────────────────

describe("infra/cloud-run.yaml reference manifest", () => {
  const manifestPath = join(REPO_ROOT, "infra", "cloud-run.yaml");
  const manifest = readFileSync(manifestPath, "utf-8");

  test("declares both web and worker services", () => {
    expect(manifest).toContain("name: langfuse-web");
    expect(manifest).toContain("name: langfuse-worker");
  });

  test("uses Secret Manager refs for all credentials", () => {
    expect(manifest).toContain("secretKeyRef:");
    // No plaintext secrets in the manifest.
    expect(manifest).not.toMatch(/password:\s*[^\s$].*/i);
  });

  test("declares healthcheck endpoints", () => {
    expect(manifest).toContain("/api/public/health");
    expect(manifest).toContain("startupProbe:");
    expect(manifest).toContain("livenessProbe:");
  });

  test("declares CPU and memory limits", () => {
    expect(manifest).toContain("cpu:");
    expect(manifest).toContain("memory:");
  });

  test("documents what cannot migrate", () => {
    // The header must enumerate the edge components — prevents accidental
    // assumption that the reconciler "can be migrated next sprint".
    expect(manifest).toContain("hooks/langfuse-sync.ts");
    expect(manifest).toContain("scripts/reconcile-traces.ts");
    expect(manifest).toContain("invariant I-13");
  });
});

// ─── 5. backup-story.md is present ───────────────────────────────────────────

describe("infra/backup-story.md PRO backup plan", () => {
  const story = readFileSync(
    join(REPO_ROOT, "infra", "backup-story.md"),
    "utf-8",
  );

  test("documents Cloud SQL PITR", () => {
    expect(story).toContain("PITR");
    expect(story).toContain("Point-In-Time Recovery");
  });

  test("documents ClickHouse backup options", () => {
    expect(story).toContain("ClickHouse Cloud");
    expect(story).toContain("BACKUP TO S3");
  });

  test("documents GCS lifecycle for MinIO replacement", () => {
    expect(story).toContain("GCS");
    expect(story).toContain("Versioning");
  });

  test("declares restore drill cadence", () => {
    expect(story).toContain("quarterly");
  });
});
