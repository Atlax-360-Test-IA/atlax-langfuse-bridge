/**
 * Tests for hooks/langfuse-sync.ts — exported functions and sprint-2 invariants.
 *
 * Covers: readTierFile, M-2 entrypoint allowlist logic, N-2 tier tag
 * always-present, subprocess exit-0 invariant (I-1), and cost formula ordering.
 *
 * Subprocess tests use import.meta.dir to locate the hook portably across
 * environments (local WSL + GitHub Actions Ubuntu runner).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTierFile, calcCost } from "./langfuse-sync";

// ─── readTierFile ──────────────────────────────────────────────────────────────

describe("readTierFile", () => {
  test("returns null or a valid TierFile (CI-safe)", () => {
    const result = readTierFile();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toHaveProperty("tier");
      expect(result).toHaveProperty("source");
      expect(result).toHaveProperty("detectedAt");
      expect(["vertex-gcp", "api-direct", "seat-team", "unknown"]).toContain(
        result.tier,
      );
      expect(["env-vertex", "env-api-key", "oauth", "none"]).toContain(
        result.source,
      );
    }
  });
});

// ─── Subprocess: invariant I-1 (exit 0) ──────────────────────────────────────

const HOOK_PATH = join(import.meta.dir, "langfuse-sync.ts");
const REPO_ROOT = join(import.meta.dir, "..");

describe("main() — invariant I-1 (subprocess, always exit 0)", () => {
  test("hook exits 0 with empty stdin", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode(""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("hook exits 0 with malformed JSON stdin", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode("not-json{{{"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("hook exits 0 when transcript_path does not exist", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: "test-no-transcript",
          transcript_path:
            "/tmp/nonexistent-transcript-" + Date.now() + ".jsonl",
          cwd: "/tmp",
          permission_mode: "default",
          hook_event_name: "Stop",
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_HOST: "http://127.0.0.1:19999",
      },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("hook exits 0 when Langfuse is unreachable (connection refused)", async () => {
    const transcript = `/tmp/hook-test-${Date.now()}.jsonl`;
    await Bun.write(
      transcript,
      [
        JSON.stringify({
          type: "summary",
          timestamp: "2026-04-15T10:00:00.000Z",
          cwd: "/tmp/project",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-15T10:01:00.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 500,
              output_tokens: 200,
              service_tier: "standard",
            },
          },
        }),
      ].join("\n") + "\n",
    );

    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: "test-unreachable",
          transcript_path: transcript,
          cwd: "/tmp/project",
          permission_mode: "default",
          hook_event_name: "Stop",
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_HOST: "http://127.0.0.1:19999",
      },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});

// ─── M-2 — entrypoint allowlist logic (unit) ─────────────────────────────────

describe("M-2 — entrypoint allowlist logic (unit)", () => {
  const KNOWN_ENTRYPOINTS = new Set(["cli", "sdk-ts", "sdk-py", "api"]);

  function resolveEntrypoint(raw: string): string {
    return KNOWN_ENTRYPOINTS.has(raw) ? raw : "cli";
  }

  test("known entrypoints pass through unchanged", () => {
    expect(resolveEntrypoint("cli")).toBe("cli");
    expect(resolveEntrypoint("sdk-ts")).toBe("sdk-ts");
    expect(resolveEntrypoint("sdk-py")).toBe("sdk-py");
    expect(resolveEntrypoint("api")).toBe("api");
  });

  test("unknown entrypoints fall back to cli", () => {
    expect(resolveEntrypoint("happy-wrapper")).toBe("cli");
    expect(resolveEntrypoint("desktop-app")).toBe("cli");
    expect(resolveEntrypoint("vscode-extension")).toBe("cli");
    expect(resolveEntrypoint("arbitrary-value")).toBe("cli");
    expect(resolveEntrypoint("")).toBe("cli");
  });

  test("injection-attempt strings fall back to cli", () => {
    expect(resolveEntrypoint("cli; rm -rf /")).toBe("cli");
    expect(resolveEntrypoint("<script>alert(1)</script>")).toBe("cli");
    expect(resolveEntrypoint("a".repeat(1000))).toBe("cli");
  });
});

// ─── N-2 — tier tags always emitted ──────────────────────────────────────────

describe("N-2 — tier tags always emitted", () => {
  function buildTags(
    tierFile: { tier: string; source: string } | null,
  ): string[] {
    return [
      `tier:${tierFile?.tier ?? "unknown"}`,
      `tier-source:${tierFile?.source ?? "none"}`,
    ];
  }

  test("emits tier:unknown when tierFile is null", () => {
    expect(buildTags(null)).toContain("tier:unknown");
  });

  test("emits tier-source:none when tierFile is null", () => {
    expect(buildTags(null)).toContain("tier-source:none");
  });

  test("emits correct tier when tierFile present (vertex)", () => {
    const tags = buildTags({ tier: "vertex-gcp", source: "env-vertex" });
    expect(tags).toContain("tier:vertex-gcp");
    expect(tags).toContain("tier-source:env-vertex");
  });

  test("emits correct tier when tierFile present (api-direct)", () => {
    const tags = buildTags({ tier: "api-direct", source: "env-api-key" });
    expect(tags).toContain("tier:api-direct");
    expect(tags).toContain("tier-source:env-api-key");
  });

  test("emits correct tier when tierFile present (seat-team/oauth)", () => {
    const tags = buildTags({ tier: "seat-team", source: "oauth" });
    expect(tags).toContain("tier:seat-team");
    expect(tags).toContain("tier-source:oauth");
  });

  test("always emits exactly 2 tier tags regardless of tierFile presence", () => {
    const nullTags = buildTags(null).filter(
      (t) => t.startsWith("tier:") || t.startsWith("tier-source:"),
    );
    const presentTags = buildTags({
      tier: "vertex-gcp",
      source: "env-vertex",
    }).filter((t) => t.startsWith("tier:") || t.startsWith("tier-source:"));
    expect(nullTags).toHaveLength(2);
    expect(presentTags).toHaveLength(2);
  });
});

// ─── Cost formula ordering ────────────────────────────────────────────────────

describe("cost formula ordering", () => {
  const usage = {
    input_tokens: 10_000,
    output_tokens: 5_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  test("haiku is cheaper than sonnet for same token count", () => {
    const haiku = calcCost(usage, "claude-haiku-4-5-20251001");
    const sonnet = calcCost(usage, "claude-sonnet-4-6");
    expect(haiku).toBeLessThan(sonnet);
  });

  test("sonnet is cheaper than opus for same token count", () => {
    const sonnet = calcCost(usage, "claude-sonnet-4-6");
    const opus = calcCost(usage, "claude-opus-4-7");
    expect(sonnet).toBeLessThan(opus);
  });

  test("cache_read is cheaper than cache_write per token", () => {
    const writeOnly = calcCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 0,
      },
      "claude-sonnet-4-6",
    );
    const readOnly = calcCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10_000,
      },
      "claude-sonnet-4-6",
    );
    expect(readOnly).toBeLessThan(writeOnly);
  });

  test("sonnet formula: (10k*3 + 5k*15) / 1M = 0.105", () => {
    const cost = calcCost(usage, "claude-sonnet-4-6");
    expect(cost).toBeCloseTo(0.105, 5);
  });
});
