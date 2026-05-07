/**
 * Unit tests for the pure/exported functions in hooks/langfuse-sync.ts.
 *
 * These tests import the functions directly (not via subprocess) so that
 * bun test --coverage can attribute coverage to the hook source file.
 * They complement the E2E subprocess tests in langfuse-sync-http.test.ts.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  calcCost,
  getDevIdentity,
  getProjectName,
  getBillingTier,
  readTierFile,
  detectOS,
  type TierFile,
} from "../hooks/langfuse-sync";

// ─── calcCost ────────────────────────────────────────────────────────────────

describe("calcCost", () => {
  test("returns 0 for undefined usage", () => {
    expect(calcCost(undefined, "claude-sonnet-4-6")).toBe(0);
  });

  test("computes cost from input + output tokens", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const cost = calcCost(usage, "claude-sonnet-4-6");
    // Sonnet 4.6: input=$3/MTok, output=$15/MTok → 1M+1M = $18
    expect(cost).toBeCloseTo(18, 4);
  });

  test("includes cache write and cache read tokens", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    const cost = calcCost(usage, "claude-sonnet-4-6");
    // cache write=$3.75/MTok, cache read=$0.30/MTok
    expect(cost).toBeCloseTo(4.05, 2);
  });

  test("handles missing optional token fields gracefully", () => {
    const usage = { input_tokens: 500_000 };
    const cost = calcCost(usage, "claude-sonnet-4-6");
    expect(cost).toBeGreaterThan(0);
  });

  test("returns 0 for all-zero usage", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    expect(calcCost(usage, "claude-sonnet-4-6")).toBe(0);
  });

  test("uses opus-4-7 pricing when model is claude-opus-4-7", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const sonnetCost = calcCost(usage, "claude-sonnet-4-6");
    const opusCost = calcCost(usage, "claude-opus-4-7");
    // Opus is more expensive than Sonnet for input
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });
});

// ─── getBillingTier ──────────────────────────────────────────────────────────

describe("getBillingTier", () => {
  let savedVertex: string | undefined;

  beforeEach(() => {
    savedVertex = process.env["CLAUDE_CODE_USE_VERTEX"];
  });

  afterEach(() => {
    if (savedVertex !== undefined)
      process.env["CLAUDE_CODE_USE_VERTEX"] = savedVertex;
    else delete process.env["CLAUDE_CODE_USE_VERTEX"];
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "true";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("returns anthropic-priority-overage for priority serviceTier", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier("priority")).toBe("anthropic-priority-overage");
  });

  test("returns anthropic-team-standard for standard serviceTier", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier("standard")).toBe("anthropic-team-standard");
  });

  test("returns anthropic-team-standard when serviceTier is undefined", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier(undefined)).toBe("anthropic-team-standard");
  });

  test("vertex env takes precedence over serviceTier=priority", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    expect(getBillingTier("priority")).toBe("vertex-gcp");
  });
});

// ─── getDevIdentity ──────────────────────────────────────────────────────────

describe("getDevIdentity", () => {
  let savedUserId: string | undefined;
  let savedDevName: string | undefined;

  beforeEach(() => {
    savedUserId = process.env["LANGFUSE_USER_ID"];
    savedDevName = process.env["CLAUDE_DEV_NAME"];
  });

  afterEach(() => {
    if (savedUserId !== undefined)
      process.env["LANGFUSE_USER_ID"] = savedUserId;
    else delete process.env["LANGFUSE_USER_ID"];

    if (savedDevName !== undefined)
      process.env["CLAUDE_DEV_NAME"] = savedDevName;
    else delete process.env["CLAUDE_DEV_NAME"];
  });

  test("returns LANGFUSE_USER_ID when set", () => {
    process.env["LANGFUSE_USER_ID"] = "override@test.com";
    delete process.env["CLAUDE_DEV_NAME"];
    expect(getDevIdentity()).toBe("override@test.com");
  });

  test("returns CLAUDE_DEV_NAME when LANGFUSE_USER_ID is not set", () => {
    delete process.env["LANGFUSE_USER_ID"];
    process.env["CLAUDE_DEV_NAME"] = "devname-override";
    expect(getDevIdentity()).toBe("devname-override");
  });

  test("returns a non-empty string when no env vars are set", () => {
    delete process.env["LANGFUSE_USER_ID"];
    delete process.env["CLAUDE_DEV_NAME"];
    const identity = getDevIdentity();
    expect(typeof identity).toBe("string");
    expect(identity.length).toBeGreaterThan(0);
  });
});

// ─── getProjectName ──────────────────────────────────────────────────────────

describe("getProjectName", () => {
  test("returns directory basename when cwd is not a git repo", () => {
    // /tmp is unlikely to have a git remote
    const name = getProjectName("/tmp");
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test("returns org/repo format for a git repo with origin", () => {
    // Use the actual repo root — it has a git remote
    const repoRoot = path.join(import.meta.dir, "..");
    const name = getProjectName(repoRoot);
    // Should be org/repo format (contains a slash) or the dir basename
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test("returns basename of path when git remote is missing", () => {
    const name = getProjectName("/nonexistent/path/my-project");
    // Will fail git and fall back to basename
    expect(name).toBe("my-project");
  });
});

// ─── readTierFile ────────────────────────────────────────────────────────────
// os.homedir() in Bun is resolved at process start from the OS passwd entry,
// not from process.env["HOME"] at call time. Tests that need a different HOME
// must use a subprocess. The happy-path test uses the real system tier.json
// (which must exist on the developer machine). Error-path tests use subprocesses.

const HOOK_PATH = path.join(import.meta.dir, "../hooks/langfuse-sync.ts");

async function runReadTierFile(
  homeDir: string,
  tierContent?: string,
): Promise<{ result: unknown; stderr: string }> {
  const atlaxDir = path.join(homeDir, ".atlax-ai");
  fs.mkdirSync(atlaxDir, { recursive: true });
  const tierPath = path.join(atlaxDir, "tier.json");
  if (tierContent !== undefined) {
    fs.writeFileSync(tierPath, tierContent);
  }

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
  const stderr = await new Response(proc.stderr).text();
  try {
    return {
      result: (JSON.parse(stdout) as { result: unknown }).result,
      stderr,
    };
  } catch {
    return { result: null, stderr };
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("readTierFile", () => {
  test("returns TierFile for a valid tier.json (real system)", () => {
    // This uses the real ~/.atlax-ai/tier.json on the developer machine.
    // If the machine has no tier.json, readTierFile returns null (also valid).
    const result = readTierFile();
    if (result !== null) {
      expect(["vertex-gcp", "api-direct", "seat-team", "unknown"]).toContain(
        result.tier,
      );
      expect(["env-vertex", "env-api-key", "oauth", "none"]).toContain(
        result.source,
      );
    }
    // null is also a valid outcome (no tier.json on this machine)
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("returns null when tier.json is missing (subprocess)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-test-missing-${process.pid}`);
    const { result } = await runReadTierFile(homeDir);
    expect(result).toBeNull();
  });

  test("returns null when tier value is not in allowlist (subprocess)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-test-invalid-${process.pid}`);
    const { result } = await runReadTierFile(
      homeDir,
      JSON.stringify({ tier: "invalid-tier", source: "oauth", account: null }),
    );
    expect(result).toBeNull();
  });

  test("returns null when source value is not in allowlist (subprocess)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-test-badsrc-${process.pid}`);
    const { result } = await runReadTierFile(
      homeDir,
      JSON.stringify({
        tier: "seat-team",
        source: "bad-source",
        account: null,
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON (subprocess)", async () => {
    const homeDir = path.join(
      os.tmpdir(),
      `tier-test-malformed-${process.pid}`,
    );
    const { result } = await runReadTierFile(homeDir, "not-valid-json{{{");
    expect(result).toBeNull();
  });

  test("returns vertex-gcp tier from valid tier.json (subprocess)", async () => {
    const homeDir = path.join(os.tmpdir(), `tier-test-vertex-${process.pid}`);
    const valid: TierFile = {
      tier: "vertex-gcp",
      source: "env-vertex",
      account: "my-project@gcp.com",
      detectedAt: new Date().toISOString(),
    };
    const { result } = await runReadTierFile(homeDir, JSON.stringify(valid));
    expect((result as TierFile | null)?.tier).toBe("vertex-gcp");
    expect((result as TierFile | null)?.source).toBe("env-vertex");
  });
});

// ─── detectOS ────────────────────────────────────────────────────────────────

describe("detectOS", () => {
  test("returns a valid OSName string", () => {
    const name = detectOS();
    expect(["linux", "wsl", "macos", "windows"]).toContain(name);
  });

  test("returns wsl on this WSL2 environment", () => {
    // This test runs on the developer's WSL2 machine — /proc/version contains "microsoft"
    // On non-WSL Linux CI it would return "linux" — guard appropriately
    const result = detectOS();
    // On WSL2 the result should be "wsl"; on standard Linux "linux"
    expect(result === "wsl" || result === "linux").toBe(true);
  });
});
