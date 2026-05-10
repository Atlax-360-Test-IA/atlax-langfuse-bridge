/**
 * Tests for shared/validation.ts — SAFE_SID_RE and safeFilePath.
 *
 * These must import from shared/validation directly (not from scripts/)
 * to catch any future divergence between the shared canonical implementation
 * and any local re-definition in a script (invariant: single-source per CLAUDE.md).
 */

import { describe, expect, test } from "bun:test";
import { SAFE_SID_RE, safeFilePath } from "./validation";
import * as path from "node:path";

// ─── SAFE_SID_RE ──────────────────────────────────────────────────────────────

describe("SAFE_SID_RE — valid session IDs", () => {
  test("accepts typical Claude Code session ID (hex-like)", () => {
    expect(SAFE_SID_RE.test("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")).toBe(true);
  });

  test("accepts UUIDs without dashes replaced by underscores", () => {
    expect(SAFE_SID_RE.test("abc123_DEF456")).toBe(true);
  });

  test("accepts alphanumeric with dashes and underscores", () => {
    expect(SAFE_SID_RE.test("session-abc-123_XYZ")).toBe(true);
  });

  test("accepts single character (min length = 1)", () => {
    expect(SAFE_SID_RE.test("a")).toBe(true);
  });

  test("accepts exactly 128 characters (max length)", () => {
    const sid = "a".repeat(128);
    expect(SAFE_SID_RE.test(sid)).toBe(true);
  });
});

describe("SAFE_SID_RE — invalid session IDs", () => {
  test("rejects empty string", () => {
    expect(SAFE_SID_RE.test("")).toBe(false);
  });

  test("rejects 129 characters (exceeds max)", () => {
    const sid = "a".repeat(129);
    expect(SAFE_SID_RE.test(sid)).toBe(false);
  });

  test("rejects path traversal attempt (../)", () => {
    expect(SAFE_SID_RE.test("../../etc/passwd")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(SAFE_SID_RE.test("session with spaces")).toBe(false);
  });

  test("rejects dots (prevents extension injection)", () => {
    expect(SAFE_SID_RE.test("session.jsonl")).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(SAFE_SID_RE.test("session\0evil")).toBe(false);
  });

  test("rejects forward slashes", () => {
    expect(SAFE_SID_RE.test("path/traversal")).toBe(false);
  });

  test("rejects special shell chars", () => {
    expect(SAFE_SID_RE.test("session;rm -rf")).toBe(false);
    expect(SAFE_SID_RE.test("session$(evil)")).toBe(false);
  });
});

// ─── safeFilePath ─────────────────────────────────────────────────────────────

describe("safeFilePath — valid paths", () => {
  test("accepts path directly inside root", () => {
    const root = "/home/user/.claude/projects";
    const p = "/home/user/.claude/projects/my-session.jsonl";
    expect(safeFilePath(root, p)).toBe(p);
  });

  test("accepts nested path inside root", () => {
    const root = "/home/user/.claude/projects";
    const p = "/home/user/.claude/projects/sub/dir/file.jsonl";
    expect(safeFilePath(root, p)).toBe(p);
  });

  test("accepts root itself", () => {
    const root = "/home/user/.claude/projects";
    expect(safeFilePath(root, root)).toBe(root);
  });

  test("resolves relative segments that stay inside root", () => {
    const root = "/home/user/.claude/projects";
    const p = "/home/user/.claude/projects/sub/../other.jsonl";
    expect(safeFilePath(root, p)).toBe(
      path.resolve("/home/user/.claude/projects/other.jsonl"),
    );
  });
});

describe("safeFilePath — path traversal attacks", () => {
  test("rejects classic path traversal", () => {
    expect(() =>
      safeFilePath("/safe/root", "/safe/root/../../../etc/passwd"),
    ).toThrow(/escapes safe root/);
  });

  test("rejects bypass via suffix prefix ambiguity", () => {
    // /safe/root-evil would start with /safe/root but is NOT inside /safe/root/
    expect(() => safeFilePath("/safe/root", "/safe/root-evil/x")).toThrow(
      /escapes safe root/,
    );
  });

  test("rejects completely different root", () => {
    expect(() => safeFilePath("/home/user/.claude", "/tmp/evil")).toThrow(
      /escapes safe root/,
    );
  });

  test("rejects empty string", () => {
    expect(() => safeFilePath("/safe/root", "")).toThrow(/non-empty string/);
  });

  test("rejects null input", () => {
    expect(() => safeFilePath("/safe/root", null as unknown as string)).toThrow(
      /non-empty string/,
    );
  });

  test("rejects non-string input", () => {
    expect(() => safeFilePath("/safe/root", 42 as unknown as string)).toThrow(
      /non-empty string/,
    );
  });
});
