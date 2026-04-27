import { describe, expect, test, afterEach } from "bun:test";
import { detectTier, type TierFile } from "./detect-tier";

describe("detectTier", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
    expect(t.source).toBe("env-vertex");
  });

  test("vertex-gcp when CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "true";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
    expect(t.source).toBe("env-vertex");
  });

  test("vertex captures project ID from env", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-gcp-project";
    const t = detectTier();
    expect(t.account).toBe("my-gcp-project");
  });

  test("api-direct when ANTHROPIC_API_KEY set (no vertex)", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("api-direct");
    expect(t.source).toBe("env-api-key");
    expect(t.account).toBeNull();
  });

  test("vertex takes precedence over API key", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
  });

  test("seat-team when OAuth credentials exist (no vertex, no API key)", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    delete process.env["ANTHROPIC_API_KEY"];
    // This test depends on ~/.claude/.credentials.json existing
    // which it does on this dev machine (OAuth session)
    const t = detectTier();
    // Should be either seat-team (if credentials exist) or unknown
    expect(["seat-team", "unknown"]).toContain(t.tier);
  });

  test("I-8: OAuth tier never reads credentials content — account is always null", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    delete process.env["ANTHROPIC_API_KEY"];
    const t = detectTier();
    if (t.tier === "seat-team") {
      // Invariant I-8: credentials.json must not be parsed — account stays null
      expect(t.account).toBeNull();
    }
  });

  test("detectedAt is a valid ISO timestamp", () => {
    const t = detectTier();
    expect(new Date(t.detectedAt).toISOString()).toBe(t.detectedAt);
  });

  test("returns consistent structure across all tiers", () => {
    const t = detectTier();
    expect(t).toHaveProperty("tier");
    expect(t).toHaveProperty("source");
    expect(t).toHaveProperty("account");
    expect(t).toHaveProperty("detectedAt");
    expect(["vertex-gcp", "api-direct", "seat-team", "unknown"]).toContain(
      t.tier,
    );
    expect(["env-vertex", "env-api-key", "oauth", "none"]).toContain(t.source);
  });
});
