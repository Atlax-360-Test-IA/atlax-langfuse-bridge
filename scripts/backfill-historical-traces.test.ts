/**
 * Tests for scripts/backfill-historical-traces.ts
 *
 * The script's main() function is a subprocess (spawns the hook), so we test
 * the pure, extractable logic: filtering, ID validation, skip-conditions.
 * Subprocess behavior is covered by integration tests in the "dry-run E2E"
 * section that actually runs the script process.
 *
 * Covered:
 *   A — SAFE_SID_RE validation (valid vs. invalid session IDs)
 *   B — subagent path filter (paths containing /subagents/)
 *   C — turns === 0 skip logic (no billable usage)
 *   D — DRY_RUN mode exits without spawning hook process (subprocess test)
 *   E — config error: missing LANGFUSE_PUBLIC_KEY → exit 1
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const BACKFILL_PATH = join(ROOT, "scripts", "backfill-historical-traces.ts");

// ─── SAFE_SID_RE validation (unit-level: regex extracted from script) ─────────

const SAFE_SID_RE = /^[0-9a-zA-Z_-]+$/;

describe("SAFE_SID_RE — session ID validation", () => {
  test("accepts alphanumeric IDs", () => {
    expect(SAFE_SID_RE.test("abc123")).toBe(true);
    expect(SAFE_SID_RE.test("ABC")).toBe(true);
    expect(SAFE_SID_RE.test("12345")).toBe(true);
  });

  test("accepts IDs with hyphens and underscores", () => {
    expect(SAFE_SID_RE.test("my-session_01")).toBe(true);
    expect(SAFE_SID_RE.test("session-2026-05-07")).toBe(true);
    expect(SAFE_SID_RE.test("abc_xyz-123")).toBe(true);
  });

  test("rejects IDs with path traversal characters", () => {
    expect(SAFE_SID_RE.test("../etc/passwd")).toBe(false);
    expect(SAFE_SID_RE.test("../../secret")).toBe(false);
  });

  test("rejects IDs with null bytes", () => {
    expect(SAFE_SID_RE.test("abc\x00def")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(SAFE_SID_RE.test("")).toBe(false);
  });

  test("rejects IDs with spaces", () => {
    expect(SAFE_SID_RE.test("session id")).toBe(false);
  });

  test("rejects IDs with special shell chars", () => {
    expect(SAFE_SID_RE.test("session;rm -rf")).toBe(false);
    expect(SAFE_SID_RE.test("session$(whoami)")).toBe(false);
    expect(SAFE_SID_RE.test("session|cat")).toBe(false);
  });
});

// ─── Subagent path filter (unit-level: filter function extracted from script) ──

function skipSubagents(paths: string[]): string[] {
  return paths.filter((p) => !p.includes("/subagents/"));
}

describe("subagent path filter", () => {
  test("passes through non-subagent paths", () => {
    const paths = [
      "/home/user/.claude/projects/my-project/abc123.jsonl",
      "/home/user/.claude/projects/other-project/xyz789.jsonl",
    ];
    expect(skipSubagents(paths)).toHaveLength(2);
  });

  test("filters out paths containing /subagents/", () => {
    const paths = [
      "/home/user/.claude/projects/my-project/subagents/agent-001.jsonl",
      "/home/user/.claude/projects/my-project/abc123.jsonl",
      "/home/user/.claude/projects/x/subagents/nested/agent.jsonl",
    ];
    expect(skipSubagents(paths)).toHaveLength(1);
    expect(skipSubagents(paths)[0]).toContain("abc123.jsonl");
  });

  test("empty input returns empty array", () => {
    expect(skipSubagents([])).toHaveLength(0);
  });

  test("all subagent paths returns empty array", () => {
    const paths = [
      "/home/user/.claude/projects/x/subagents/a.jsonl",
      "/home/user/.claude/projects/x/subagents/b.jsonl",
    ];
    expect(skipSubagents(paths)).toHaveLength(0);
  });
});

// ─── Subprocess tests ─────────────────────────────────────────────────────────

async function runBackfill(
  env: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", BACKFILL_PATH], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    cwd: ROOT,
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("backfill subprocess timeout")),
      timeoutMs,
    ),
  );

  const [stdout, stderr] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]),
    timeout,
  ]);

  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

describe("backfill-historical-traces.ts subprocess — config errors", () => {
  test("exits with code 1 when LANGFUSE_PUBLIC_KEY is missing", async () => {
    // Config check happens before discoverRecentJsonls, so this should be fast.
    // Use CLAUDE_PROJECTS_ROOT env hint if available to speed up the scan.
    const result = await runBackfill(
      {
        LANGFUSE_PUBLIC_KEY: "",
        LANGFUSE_SECRET_KEY: "",
      },
      10_000,
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(
      result.stdout.split("\n").filter(Boolean)[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(parsed["level"]).toBe("error");
    expect(String(parsed["msg"] ?? "")).toContain("LANGFUSE_PUBLIC_KEY");
  }, 10_000);
});

describe("backfill-historical-traces.ts subprocess — DRY_RUN mode", () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "backfill-test-"));
    const projectDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectDir, { recursive: true });

    // Session with valid usage (turns > 0)
    const sessionId = "abc123test";
    jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      jsonlPath,
      [
        '{"type":"summary","timestamp":"2026-05-01T10:00:00.000Z","sessionId":"abc123test","cwd":"/tmp/test"}',
        '{"type":"assistant","timestamp":"2026-05-01T10:01:00.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50}}}',
      ].join("\n") + "\n",
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("DRY_RUN=1 prints would-upload lines without spawning hook", async () => {
    // We verify DRY_RUN by checking no hook process is actually called
    // (no HTTP requests, no LANGFUSE errors — only stdout log lines)
    const result = await runBackfill({
      DRY_RUN: "1",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_HOST: "http://localhost:9999", // intentionally unreachable
      HOME: tmpDir,
      THROTTLE_MS: "0",
    });

    // In DRY_RUN mode, script should exit 0 (no actual uploads attempted)
    expect(result.exitCode).toBe(0);

    // stdout should contain structured JSON log lines
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const logObjects = lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    const scanStarted = logObjects.find((o) => o["msg"] === "scan-started");
    expect(scanStarted).toBeDefined();
    expect(scanStarted!["dryRun"]).toBe(true);

    const scanCompleted = logObjects.find((o) => o["msg"] === "scan-completed");
    expect(scanCompleted).toBeDefined();

    // Should NOT contain hook-replay errors (no real hook spawned)
    const errors = logObjects.filter((o) => o["msg"] === "hook-replay-failed");
    expect(errors).toHaveLength(0);
  });

  test("DRY_RUN=1 skips sessions with turns=0 (no assistant messages)", async () => {
    // Create an empty session (only user messages)
    const projectDir = join(tmpDir, ".claude", "projects", "test-project");
    const emptySessionPath = join(projectDir, "empty999.jsonl");
    writeFileSync(
      emptySessionPath,
      '{"type":"user","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n',
    );

    const result = await runBackfill({
      DRY_RUN: "1",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      HOME: tmpDir,
      THROTTLE_MS: "0",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    const logObjects = lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    const completed = logObjects.find((o) => o["msg"] === "scan-completed");
    expect(completed).toBeDefined();
    expect(completed!["skippedNoUsage"] as number).toBeGreaterThanOrEqual(1);
  });

  test("scan-started log reports dryRun=true and throttleMs=0", async () => {
    // Validates the structured log shape from scan-started (observable contract)
    const result = await runBackfill({
      DRY_RUN: "1",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      HOME: tmpDir,
      THROTTLE_MS: "0",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    const logObjects = lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>,
    );
    const started = logObjects.find((o) => o["msg"] === "scan-started");
    expect(started).toBeDefined();
    expect(started!["dryRun"]).toBe(true);
    expect(started!["throttleMs"]).toBe(0);
    expect(started!["windowHours"]).toBe(8760);
    // afterSubagentFilter ≤ totalCandidates (filter is applied)
    expect(started!["afterSubagentFilter"] as number).toBeLessThanOrEqual(
      started!["totalCandidates"] as number,
    );
  });
});
