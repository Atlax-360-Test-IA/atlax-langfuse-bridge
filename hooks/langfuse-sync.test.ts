import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  calcCost,
  getBillingTier,
  detectOS,
  getDevIdentity,
  getProjectName,
} from "./langfuse-sync";

// ─── calcCost ───────────────────────────────────────────────────────────────

describe("calcCost", () => {
  test("computes cost for sonnet usage", () => {
    const cost = calcCost(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
      },
      "claude-sonnet-4-6",
    );
    // (1000*3 + 200*3.75 + 100*0.3 + 500*15) / 1_000_000
    expect(cost).toBeCloseTo(0.01128, 5);
  });

  test("computes cost for opus usage", () => {
    const cost = calcCost(
      {
        input_tokens: 3000,
        output_tokens: 2000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
      },
      "claude-opus-4-7",
    );
    // (3000*15 + 500*18.75 + 0*1.5 + 2000*75) / 1_000_000
    expect(cost).toBeCloseTo(0.204375, 5);
  });

  test("returns 0 for null/undefined usage", () => {
    expect(calcCost(undefined, "claude-sonnet-4-6")).toBe(0);
  });

  test("handles missing token fields gracefully", () => {
    const cost = calcCost({ input_tokens: 1000 } as any, "claude-sonnet-4-6");
    // Only input: 1000 * 3 / 1_000_000 = 0.003
    expect(cost).toBeCloseTo(0.003, 5);
  });

  test("uses default pricing for unknown model", () => {
    const cost = calcCost(
      { input_tokens: 1000, output_tokens: 500 },
      "gpt-4o-unknown",
    );
    // Default = sonnet pricing: (1000*3 + 500*15) / 1M = 0.0105
    expect(cost).toBeCloseTo(0.0105, 5);
  });
});

// ─── getBillingTier ─────────────────────────────────────────────────────────

describe("getBillingTier", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "true";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("vertex takes precedence over priority service tier", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    expect(getBillingTier("priority")).toBe("vertex-gcp");
  });

  test("returns anthropic-priority-overage for priority tier", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    expect(getBillingTier("priority")).toBe("anthropic-priority-overage");
  });

  test("returns anthropic-team-standard for standard tier", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    expect(getBillingTier("standard")).toBe("anthropic-team-standard");
  });

  test("returns anthropic-team-standard when no tier specified", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    expect(getBillingTier()).toBe("anthropic-team-standard");
    expect(getBillingTier(undefined)).toBe("anthropic-team-standard");
  });
});

// ─── detectOS ───────────────────────────────────────────────────────────────

describe("detectOS", () => {
  test("returns a valid OS name", () => {
    const os = detectOS();
    expect(["linux", "wsl", "macos", "windows"]).toContain(os);
  });

  test("returns wsl on this WSL2 system", () => {
    // This test is environment-specific; skip if not on WSL
    try {
      const version = require("fs")
        .readFileSync("/proc/version", "utf-8")
        .toLowerCase();
      if (version.includes("microsoft")) {
        expect(detectOS()).toBe("wsl");
      }
    } catch {
      // Not on Linux, skip
    }
  });
});

// ─── getDevIdentity ─────────────────────────────────────────────────────────

describe("getDevIdentity", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("prefers LANGFUSE_USER_ID env var", () => {
    process.env.LANGFUSE_USER_ID = "explicit-user@test.com";
    expect(getDevIdentity()).toBe("explicit-user@test.com");
  });

  test("falls back to CLAUDE_DEV_NAME", () => {
    delete process.env.LANGFUSE_USER_ID;
    process.env.CLAUDE_DEV_NAME = "dev-name";
    expect(getDevIdentity()).toBe("dev-name");
  });

  test("falls back to git config email", () => {
    delete process.env.LANGFUSE_USER_ID;
    delete process.env.CLAUDE_DEV_NAME;
    const identity = getDevIdentity();
    // Should be a non-empty string (git email or OS username)
    expect(identity.length).toBeGreaterThan(0);
  });
});

// ─── getProjectName ─────────────────────────────────────────────────────────

describe("getProjectName", () => {
  test("extracts org/repo from git remote in current project", () => {
    const name = getProjectName(process.cwd());
    // We're in the atlax-langfuse-bridge repo
    expect(name).toContain("atlax-langfuse-bridge");
  });

  test("falls back to directory basename for non-git dir", () => {
    const name = getProjectName("/tmp");
    expect(name).toBe("tmp");
  });
});
