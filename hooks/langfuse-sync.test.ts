import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  calcCost,
  getBillingTier,
  detectOS,
  getDevIdentity,
  getProjectName,
} from "./langfuse-sync";
import { emitDegradation, type DegradationEntry } from "../shared/degradation";
import { saveEnv, restoreEnv } from "../tests/helpers/env";

const BILLING_ENV_KEYS = ["CLAUDE_CODE_USE_VERTEX"] as const;
const DEV_IDENTITY_ENV_KEYS = ["LANGFUSE_USER_ID", "CLAUDE_DEV_NAME"] as const;

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

  test("computes cost for opus 4.7 usage (pricing nuevo $5/$25)", () => {
    const cost = calcCost(
      {
        input_tokens: 3000,
        output_tokens: 2000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
      },
      "claude-opus-4-7",
    );
    // (3000*5 + 500*6.25 + 0*0.5 + 2000*25) / 1_000_000
    // = (15000 + 3125 + 0 + 50000) / 1_000_000 = 0.068125
    expect(cost).toBeCloseTo(0.068125, 5);
  });

  test("computes cost for opus 4.1 usage (pricing legacy $15/$75)", () => {
    const cost = calcCost(
      {
        input_tokens: 3000,
        output_tokens: 2000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
      },
      "claude-opus-4-1",
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
  const SAVED = saveEnv(BILLING_ENV_KEYS);

  afterEach(() => {
    restoreEnv(SAVED);
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("returns vertex-gcp when CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "true";
    expect(getBillingTier()).toBe("vertex-gcp");
  });

  test("vertex takes precedence over priority service tier", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    expect(getBillingTier("priority")).toBe("vertex-gcp");
  });

  test("returns anthropic-priority-overage for priority tier", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier("priority")).toBe("anthropic-priority-overage");
  });

  test("returns anthropic-team-standard for standard tier", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    expect(getBillingTier("standard")).toBe("anthropic-team-standard");
  });

  test("returns anthropic-team-standard when no tier specified", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
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
  const SAVED = saveEnv(DEV_IDENTITY_ENV_KEYS);

  afterEach(() => {
    restoreEnv(SAVED);
  });

  test("prefers LANGFUSE_USER_ID env var", () => {
    process.env["LANGFUSE_USER_ID"] = "explicit-user@test.com";
    expect(getDevIdentity()).toBe("explicit-user@test.com");
  });

  test("falls back to CLAUDE_DEV_NAME", () => {
    delete process.env["LANGFUSE_USER_ID"];
    process.env["CLAUDE_DEV_NAME"] = "dev-name";
    expect(getDevIdentity()).toBe("dev-name");
  });

  test("falls back to git config email", () => {
    delete process.env["LANGFUSE_USER_ID"];
    delete process.env["CLAUDE_DEV_NAME"];
    const identity = getDevIdentity();
    // Should be a non-empty string (git email or OS username)
    expect(identity.length).toBeGreaterThan(0);
  });
});

// ─── emitDegradation ────────────────────────────────────────────────────────

describe("emitDegradation", () => {
  test("writes valid JSON to stderr with required fields", () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (s: string | Uint8Array) => {
        written.push(typeof s === "string" ? s : new TextDecoder().decode(s));
        return true;
      },
    );

    emitDegradation("test:source", new Error("something failed"));

    spy.mockRestore();

    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as DegradationEntry;
    expect(parsed.type).toBe("degradation");
    expect(parsed.source).toBe("test:source");
    expect(parsed.error).toBe("something failed");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("handles non-Error thrown values", () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (s: string | Uint8Array) => {
        written.push(typeof s === "string" ? s : new TextDecoder().decode(s));
        return true;
      },
    );

    emitDegradation("test:source", "string error");

    spy.mockRestore();

    const parsed = JSON.parse(written[0]!) as DegradationEntry;
    expect(parsed.error).toBe("string error");
  });

  test("entry is newline-terminated for journald compatibility", () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (s: string | Uint8Array) => {
        written.push(typeof s === "string" ? s : new TextDecoder().decode(s));
        return true;
      },
    );

    emitDegradation("test:source", new Error("x"));

    spy.mockRestore();

    expect(written[0]).toEndWith("\n");
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
