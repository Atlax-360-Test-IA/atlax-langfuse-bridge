/**
 * Regression guards for the PRO backup hardening (2026-05-10).
 *
 * Encodes invariants of the post-F1 backup story:
 *  1. ClickHouse snapshot retention is 7d (not 3d minimum-viable).
 *  2. The clickhouse-backup-s3.sh script exists, is executable, and
 *     follows the canonical script pattern (shebang, JSON logging, dry-run).
 *  3. The restore-drill.sh script exists and supports --dry-run + --no-teardown.
 *  4. backup-story.md is in sync with reality (no stale "PLANNED — not yet
 *     implemented" status; lists the executed drill).
 *
 * If any of these fail, someone shipped a regression in the backup posture.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

// ─── 1. provision-pro.sh declares retention=7 ────────────────────────────────

describe("provision-pro.sh — ClickHouse snapshot retention", () => {
  const provisionPath = join(REPO_ROOT, "infra", "provision-pro.sh");
  const content = readFileSync(provisionPath, "utf-8");

  test("declares --max-retention-days=7 (not 3, not other)", () => {
    expect(content).toContain("--max-retention-days=7");
    expect(content).not.toContain("--max-retention-days=3");
  });

  test("snapshot policy uses on-source-disk-delete=keep-auto-snapshots", () => {
    // Critical: prevents losing snapshots if the disk is recreated.
    expect(content).toContain("--on-source-disk-delete=keep-auto-snapshots");
  });
});

// ─── 2. clickhouse-backup-s3.sh exists + canonical script pattern ────────────

describe("scripts/clickhouse-backup-s3.sh", () => {
  const scriptPath = join(REPO_ROOT, "scripts", "clickhouse-backup-s3.sh");

  test("exists and is executable", () => {
    const stat = statSync(scriptPath);
    expect(stat.isFile()).toBe(true);
    // Mode bits: owner execute is 0o100
    expect(stat.mode & 0o100).not.toBe(0);
  });

  const content = readFileSync(scriptPath, "utf-8");

  test("uses bash with strict mode", () => {
    expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(content).toContain("set -euo pipefail");
  });

  test("supports --dry-run flag", () => {
    expect(content).toContain("--dry-run");
    expect(content).toContain("DRY_RUN");
  });

  test("emits structured JSON logs (matching canonical pattern)", () => {
    // Same pattern as scripts/backup-langfuse.sh — single source of truth.
    expect(content).toMatch(/printf '\{"ts":"%s","level":"%s","service":"/);
  });

  test("validates VM is RUNNING before attempting backup (preflight)", () => {
    expect(content).toContain("VM_STATUS");
    expect(content).toContain("RUNNING");
  });

  test("uses timestamped backup paths (avoids BACKUP_ALREADY_EXISTS)", () => {
    // ClickHouse BACKUP TO S3 fails with code 598 if path collides.
    // Path must include date+time, not just date.
    expect(content).toContain("BACKUP_TIMESTAMP");
    expect(content).toContain("date -u");
  });

  test("uses sudo docker exec (VM ssh user not in docker group)", () => {
    // Discovered during first real run on 2026-05-10 — without sudo,
    // the docker daemon socket access is denied.
    expect(content).toContain("sudo docker exec");
  });
});

// ─── 3. restore-drill.sh exists + canonical pattern ─────────────────────────

describe("scripts/restore-drill.sh", () => {
  const scriptPath = join(REPO_ROOT, "scripts", "restore-drill.sh");

  test("exists and is executable", () => {
    const stat = statSync(scriptPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).not.toBe(0);
  });

  const content = readFileSync(scriptPath, "utf-8");

  test("uses bash with strict mode", () => {
    expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(content).toContain("set -euo pipefail");
  });

  test("supports --dry-run AND --no-teardown", () => {
    expect(content).toContain("--dry-run");
    expect(content).toContain("--no-teardown");
  });

  test("declares trap-based cleanup for safety", () => {
    // Resources cost money — ensure tear-down runs even on early exit.
    expect(content).toContain("trap cleanup EXIT");
  });

  test("validates Postgres PITR via Cloud SQL clone", () => {
    expect(content).toContain("gcloud sql instances clone");
    expect(content).toContain("--point-in-time");
  });

  test("validates ClickHouse via snapshot disk creation", () => {
    expect(content).toContain("gcloud compute disks create");
    expect(content).toContain("--source-snapshot");
  });

  test("validates ClickHouse via S3 backup listing", () => {
    expect(content).toContain("gcloud storage ls");
  });

  test("warns when bucket is empty (not silent pass)", () => {
    expect(content).toMatch(/bucket gs.*vacío|bucket.*empty/i);
  });
});

// ─── 4. backup-story.md is in sync with reality ──────────────────────────────

describe("infra/backup-story.md — current state reflects reality", () => {
  const story = readFileSync(
    join(REPO_ROOT, "infra", "backup-story.md"),
    "utf-8",
  );

  test("does NOT claim 'PLANNED — not yet implemented'", () => {
    // F1-F4 already executed; the doc must reflect that.
    expect(story).not.toContain("PLANNED — not yet implemented");
    expect(story).not.toContain("PLANNED - not yet implemented");
  });

  test("documents the current state section (post-F1)", () => {
    expect(story).toMatch(/Current state|Estado actual/i);
  });

  test("lists the operational scripts in the toolkit", () => {
    expect(story).toContain("clickhouse-backup-s3.sh");
    expect(story).toContain("restore-drill.sh");
  });

  test("contains at least one drill log entry (not 'Empty')", () => {
    // The first drill ran 2026-05-10. If this test fails, someone wiped
    // the drill log without running a new one.
    expect(story).toMatch(/Drill log/i);
    expect(story).not.toMatch(/_Empty\s*—/);
  });
});
