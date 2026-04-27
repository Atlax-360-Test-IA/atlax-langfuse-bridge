import { describe, expect, test } from "bun:test";
import { validateUser, validateTurn, isSafeHost } from "./validators.js";

// ─── validateUser ─────────────────────────────────────────────────────────────

describe("validateUser", () => {
  test("returns email object for valid detail", () => {
    expect(validateUser({ email: "user@example.com" })).toEqual({
      email: "user@example.com",
    });
  });

  test("returns null for null detail", () => {
    expect(validateUser(null)).toBeNull();
  });

  test("returns null for non-object detail", () => {
    expect(validateUser("string")).toBeNull();
    expect(validateUser(42)).toBeNull();
  });

  test("returns null when email is missing", () => {
    expect(validateUser({})).toBeNull();
  });

  test("returns null when email exceeds 256 chars", () => {
    expect(validateUser({ email: "a".repeat(257) })).toBeNull();
  });

  test("returns null when email is not a string", () => {
    expect(validateUser({ email: 123 })).toBeNull();
  });

  test("returns null for string without @ (not an email)", () => {
    expect(validateUser({ email: "notanemail" })).toBeNull();
  });

  test("returns null for string with @ but no domain dot", () => {
    expect(validateUser({ email: "user@nodot" })).toBeNull();
  });

  test("accepts well-formed email within length limit", () => {
    expect(validateUser({ email: "user@example.com" })).toEqual({
      email: "user@example.com",
    });
  });
});

// ─── validateTurn ─────────────────────────────────────────────────────────────

const validTurn = {
  model: "claude-sonnet-4-6",
  inputTokens: 1000,
  outputTokens: 500,
  surface: "chat" as const,
  platform: "browser" as const,
  conversationId: "550e8400-e29b-41d4-a716-446655440000",
  url: "https://claude.ai/chat/123",
  timestamp: "2026-04-26T10:00:00.000Z",
};

describe("validateTurn", () => {
  test("returns all fields for valid detail", () => {
    const result = validateTurn(validTurn);
    expect(result).toEqual(validTurn);
  });

  test("returns null for null detail", () => {
    expect(validateTurn(null)).toBeNull();
  });

  test("returns null for non-object detail", () => {
    expect(validateTurn("bad")).toBeNull();
  });

  test("model truncated to 128 chars", () => {
    const longModel = "x".repeat(200);
    const result = validateTurn({ ...validTurn, model: longModel });
    expect(result!.model).toHaveLength(128);
  });

  test("model null for non-string", () => {
    const result = validateTurn({ ...validTurn, model: 42 });
    expect(result!.model).toBeNull();
  });

  test("inputTokens defaults to 0 for negative value", () => {
    const result = validateTurn({ ...validTurn, inputTokens: -5 });
    expect(result!.inputTokens).toBe(0);
  });

  test("inputTokens defaults to 0 for Infinity", () => {
    const result = validateTurn({ ...validTurn, inputTokens: Infinity });
    expect(result!.inputTokens).toBe(0);
  });

  test("outputTokens defaults to 0 for NaN", () => {
    const result = validateTurn({ ...validTurn, outputTokens: NaN });
    expect(result!.outputTokens).toBe(0);
  });

  test("surface defaults to unknown for unexpected value", () => {
    const result = validateTurn({ ...validTurn, surface: "malicious" });
    expect(result!.surface).toBe("unknown");
  });

  test("surface accepts all valid values", () => {
    for (const surface of ["chat", "projects", "unknown"]) {
      expect(validateTurn({ ...validTurn, surface })!.surface).toBe(surface);
    }
  });

  test("platform defaults to browser for unexpected value", () => {
    const result = validateTurn({ ...validTurn, platform: "electron" });
    expect(result!.platform).toBe("browser");
  });

  test("conversationId null for non-UUID string", () => {
    const result = validateTurn({
      ...validTurn,
      conversationId: "../secret",
    });
    expect(result!.conversationId).toBeNull();
  });

  test("conversationId null for non-string", () => {
    const result = validateTurn({ ...validTurn, conversationId: 123 });
    expect(result!.conversationId).toBeNull();
  });

  test("url null for non-claude.ai URL", () => {
    const result = validateTurn({
      ...validTurn,
      url: "https://evil.com/steal",
    });
    expect(result!.url).toBeNull();
  });

  test("url null for javascript: scheme", () => {
    const result = validateTurn({
      ...validTurn,
      url: "javascript:alert(1)",
    });
    expect(result!.url).toBeNull();
  });

  test("url truncated to 2048 chars", () => {
    const url = "https://claude.ai/" + "x".repeat(3000);
    const result = validateTurn({ ...validTurn, url });
    expect(result!.url).toHaveLength(2048);
  });

  test("timestamp truncated to 64 chars", () => {
    const timestamp = "2026-04-26T10:00:00.000Z" + "x".repeat(100);
    const result = validateTurn({ ...validTurn, timestamp });
    expect(result!.timestamp).toHaveLength(64);
  });

  test("timestamp null for non-string", () => {
    const result = validateTurn({ ...validTurn, timestamp: null });
    expect(result!.timestamp).toBeNull();
  });
});

// ─── isSafeHost ──────────────────────────────────────────────────────────────

describe("isSafeHost", () => {
  test("accepts https:// URL", () => {
    expect(isSafeHost("https://langfuse.example.com")).toBe(true);
  });

  test("accepts http://localhost", () => {
    expect(isSafeHost("http://localhost:3000")).toBe(true);
  });

  test("accepts http://127.0.0.1", () => {
    expect(isSafeHost("http://127.0.0.1:3000")).toBe(true);
  });

  test("rejects http:// with non-localhost host", () => {
    expect(isSafeHost("http://internal.company.com")).toBe(false);
  });

  test("rejects file:// URL", () => {
    expect(isSafeHost("file:///etc/passwd")).toBe(false);
  });

  test("rejects javascript: URL", () => {
    expect(isSafeHost("javascript:alert(1)")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSafeHost("")).toBe(false);
  });

  test("rejects non-string", () => {
    expect(isSafeHost(null)).toBe(false);
    expect(isSafeHost(undefined)).toBe(false);
    expect(isSafeHost(42)).toBe(false);
  });

  test("rejects string exceeding 2048 chars", () => {
    expect(isSafeHost("https://" + "a".repeat(2100))).toBe(false);
  });

  test("rejects relative path", () => {
    expect(isSafeHost("/api/ingest")).toBe(false);
  });

  test("rejects path traversal attempt", () => {
    expect(isSafeHost("http://localhost/../../../etc/passwd")).toBe(false);
  });
});
