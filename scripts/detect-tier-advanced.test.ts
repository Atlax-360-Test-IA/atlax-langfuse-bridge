/**
 * Advanced tests for scripts/detect-tier.ts covering the env-api-key,
 * oauth, and unknown paths not covered by the basic suite.
 * Also covers writeIfChanged() and labelFor() exported helpers.
 */

import { describe, expect, test, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTier,
  writeIfChanged,
  labelFor,
  type TierFile,
} from "./detect-tier";

const ADV_ENV_KEYS = [
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_API_KEY",
] as const;

describe("detectTier — tier resolution order", () => {
  const advSaved: Partial<Record<(typeof ADV_ENV_KEYS)[number], string>> = {};
  for (const k of ADV_ENV_KEYS) {
    if (process.env[k] !== undefined) advSaved[k] = process.env[k];
  }

  afterEach(() => {
    for (const k of ADV_ENV_KEYS) {
      if (advSaved[k] !== undefined) process.env[k] = advSaved[k];
      else delete process.env[k];
    }
  });

  test("vertex-gcp when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    delete process.env["ANTHROPIC_API_KEY"];
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

  test("vertex includes project ID as account when set", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-gcp-project";
    const t = detectTier();
    expect(t.account).toBe("my-gcp-project");
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = undefined;
  });

  test("vertex account is null when project ID not set", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    delete process.env["ANTHROPIC_VERTEX_PROJECT_ID"];
    const t = detectTier();
    expect(t.account).toBeNull();
  });

  test("api-direct when ANTHROPIC_API_KEY is set (no vertex)", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("api-direct");
    expect(t.source).toBe("env-api-key");
    expect(t.account).toBeNull();
  });

  test("vertex takes precedence over ANTHROPIC_API_KEY", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const t = detectTier();
    expect(t.tier).toBe("vertex-gcp");
  });

  test("seat-team when credentials.json exists (I-8: only checks existence)", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    delete process.env["ANTHROPIC_API_KEY"];
    // Mock existsSync to simulate credentials file present
    const spy = spyOn(fs, "existsSync").mockReturnValue(true);
    const t = detectTier();
    spy.mockRestore();
    expect(t.tier).toBe("seat-team");
    expect(t.source).toBe("oauth");
    expect(t.account).toBeNull();
  });

  test("unknown when no env vars and no credentials file", () => {
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    delete process.env["ANTHROPIC_API_KEY"];
    const spy = spyOn(fs, "existsSync").mockReturnValue(false);
    const t = detectTier();
    spy.mockRestore();
    expect(t.tier).toBe("unknown");
    expect(t.source).toBe("none");
    expect(t.account).toBeNull();
  });

  test("detectedAt is a valid ISO timestamp", () => {
    process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
    const t = detectTier();
    expect(t.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─── labelFor ────────────────────────────────────────────────────────────────

describe("labelFor", () => {
  const base = { source: "env-vertex" as const, account: null, detectedAt: "" };

  test("vertex-gcp without account", () => {
    expect(labelFor({ ...base, tier: "vertex-gcp" })).toBe("☁ vertex");
  });

  test("vertex-gcp with account includes it in label", () => {
    expect(
      labelFor({ ...base, tier: "vertex-gcp", account: "my-project" }),
    ).toBe("☁ vertex my-project");
  });

  test("api-direct label", () => {
    expect(labelFor({ ...base, tier: "api-direct" })).toBe("⚡ api");
  });

  test("seat-team label", () => {
    expect(labelFor({ ...base, tier: "seat-team" })).toBe("◆ seat");
  });

  test("unknown label", () => {
    expect(labelFor({ ...base, tier: "unknown" })).toBe("? tier");
  });
});

// ─── writeIfChanged — real filesystem with backup/restore ────────────────────
// TIER_PATH is a module-level constant (join(homedir(), ".atlax-ai", "tier.json"))
// computed at import time. HOME override or spyOn named imports cannot redirect it.
// We operate on the real path with backup/restore to keep tests hermetic.

describe("writeIfChanged", () => {
  const ATLAX_DIR = join(require("node:os").homedir(), ".atlax-ai");
  const TIER_PATH = join(ATLAX_DIR, "tier.json");
  const BACKUP_PATH = join(ATLAX_DIR, "tier.json.test-bak");

  const makeTier = (t: TierFile["tier"] = "api-direct"): TierFile => ({
    tier: t,
    source: "env-api-key",
    account: null,
    detectedAt: new Date().toISOString(),
  });

  // Backup real tier.json before each test; restore after.
  const backup = () => {
    if (fs.existsSync(TIER_PATH)) fs.copyFileSync(TIER_PATH, BACKUP_PATH);
  };
  const restore = () => {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, TIER_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
  };

  test("returns true and writes when tier differs from existing", () => {
    backup();
    try {
      // Write a known state first
      const sentinel: TierFile = {
        tier: "vertex-gcp",
        source: "env-vertex",
        account: "sentinel",
        detectedAt: "2000-01-01T00:00:00.000Z",
      };
      fs.mkdirSync(ATLAX_DIR, { recursive: true });
      fs.writeFileSync(TIER_PATH, JSON.stringify(sentinel));

      const changed = writeIfChanged(makeTier("api-direct"));
      expect(changed).toBe(true);

      const written = JSON.parse(
        fs.readFileSync(TIER_PATH, "utf-8"),
      ) as TierFile;
      expect(written.tier).toBe("api-direct");
    } finally {
      restore();
    }
  });

  test("returns false when tier, source, and account are identical", () => {
    backup();
    try {
      const t = makeTier();
      // Pre-write the same tier
      fs.mkdirSync(ATLAX_DIR, { recursive: true });
      fs.writeFileSync(
        TIER_PATH,
        JSON.stringify({
          tier: t.tier,
          source: t.source,
          account: t.account,
          detectedAt: "past",
        }),
      );

      const changed = writeIfChanged(t);
      expect(changed).toBe(false);
    } finally {
      restore();
    }
  });

  test("handles corrupt existing file and rewrites successfully", () => {
    backup();
    try {
      fs.mkdirSync(ATLAX_DIR, { recursive: true });
      fs.writeFileSync(TIER_PATH, "not-valid-json{{{{");

      const changed = writeIfChanged(makeTier());
      expect(changed).toBe(true);

      // File should now contain valid JSON
      const written = JSON.parse(
        fs.readFileSync(TIER_PATH, "utf-8"),
      ) as TierFile;
      expect(written.tier).toBe("api-direct");
    } finally {
      restore();
    }
  });

  test("atomic write: file content is consistent after writeIfChanged", () => {
    backup();
    try {
      const t = makeTier("seat-team");
      // Force a write by using different source
      fs.mkdirSync(ATLAX_DIR, { recursive: true });
      fs.writeFileSync(
        TIER_PATH,
        JSON.stringify({
          tier: "unknown",
          source: "none",
          account: null,
          detectedAt: "past",
        }),
      );

      writeIfChanged(t);
      const written = JSON.parse(
        fs.readFileSync(TIER_PATH, "utf-8"),
      ) as TierFile;
      expect(written.tier).toBe("seat-team");
      expect(written.source).toBe("env-api-key");
      expect(written.account).toBeNull();
      expect(written.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      restore();
    }
  });
});
