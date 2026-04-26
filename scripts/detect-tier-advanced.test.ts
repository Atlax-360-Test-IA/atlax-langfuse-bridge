/**
 * Advanced tests for scripts/detect-tier.ts covering the env-api-key,
 * oauth, and unknown paths not covered by the basic suite.
 */

import { describe, expect, test, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { detectTier } from "./detect-tier";

describe("detectTier — tier resolution order", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test("vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    delete process.env.ANTHROPIC_API_KEY;
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
    expect(t.source).toBe("env-vertex");
  });

  test("vertex-gcp when CLAUDE_CODE_USE_VERTEX=true", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "true";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
    expect(t.source).toBe("env-vertex");
  });

  test("vertex includes project ID as account when set", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-gcp-project";
    const t = detectTier();
    expect(t.account).toBe("my-gcp-project");
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = undefined;
  });

  test("vertex account is null when project ID not set", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    const t = detectTier();
    expect(t.account).toBeNull();
  });

  test("api-direct when ANTHROPIC_API_KEY is set (no vertex)", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("api-direct");
    expect(t.source).toBe("env-api-key");
    expect(t.account).toBeNull();
  });

  test("vertex takes precedence over ANTHROPIC_API_KEY", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
  });

  test("seat-team when credentials.json exists (I-8: only checks existence)", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.ANTHROPIC_API_KEY;
    // Mock existsSync to simulate credentials file present
    const spy = spyOn(fs, "existsSync").mockReturnValue(true);
    const t = detectTier();
    spy.mockRestore();
    expect(t.tier).toBe("seat-team");
    expect(t.source).toBe("oauth");
    expect(t.account).toBeNull();
  });

  test("unknown when no env vars and no credentials file", () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.ANTHROPIC_API_KEY;
    const spy = spyOn(fs, "existsSync").mockReturnValue(false);
    const t = detectTier();
    spy.mockRestore();
    expect(t.tier).toBe("unknown");
    expect(t.source).toBe("none");
    expect(t.account).toBeNull();
  });

  test("detectedAt is a valid ISO timestamp", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    const t = detectTier();
    expect(t.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
