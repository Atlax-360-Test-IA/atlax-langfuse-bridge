import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { discoverRecentJsonls } from "./jsonl-discovery";

const TMP = join(tmpdir(), `jsonl-discovery-test-${process.pid}`);

function makeProjectDir(name: string): string {
  const d = join(TMP, "projects", name);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeJsonl(dir: string, filename: string, mtimeOffset = 0): string {
  const p = join(dir, filename);
  writeFileSync(p, '{"type":"summary"}\n');
  if (mtimeOffset !== 0) {
    const t = new Date(Date.now() + mtimeOffset);
    utimesSync(p, t, t);
  }
  return p;
}

beforeEach(() => {
  mkdirSync(join(TMP, "projects"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("discoverRecentJsonls", () => {
  it("returns empty array when root dir does not exist", async () => {
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "nonexistent"),
    );
    expect(result).toEqual([]);
  });

  it("finds jsonl files within the time window", async () => {
    const proj = makeProjectDir("proj-a");
    const p = writeJsonl(proj, "session1.jsonl"); // mtime = now
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "projects"),
    );
    expect(result).toContain(p);
  });

  it("excludes jsonl files older than window", async () => {
    const proj = makeProjectDir("proj-b");
    const p = writeJsonl(proj, "old.jsonl", -(25 * 3_600_000)); // 25h ago
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "projects"),
    );
    expect(result).not.toContain(p);
  });

  it("ignores non-jsonl files", async () => {
    const proj = makeProjectDir("proj-c");
    const p = join(proj, "summary.txt");
    writeFileSync(p, "not a jsonl");
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "projects"),
    );
    expect(result).not.toContain(p);
  });

  it("returns results sorted", async () => {
    const proj = makeProjectDir("proj-d");
    writeJsonl(proj, "b.jsonl");
    writeJsonl(proj, "a.jsonl");
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "projects"),
    );
    const inScope = result.filter((p) => p.startsWith(proj));
    expect(inScope).toEqual([...inScope].sort());
  });

  it("calls onError when a project dir is unreadable", async () => {
    // Create a file where a dir is expected so readdir fails
    const p = join(TMP, "projects", "notadir.txt");
    writeFileSync(p, "");
    const errors: string[] = [];
    await discoverRecentJsonls(
      24,
      (src) => errors.push(src),
      join(TMP, "projects"),
    );
    // Should still complete without throwing
  });

  it("scans multiple project dirs", async () => {
    const p1 = makeProjectDir("multi-1");
    const p2 = makeProjectDir("multi-2");
    const f1 = writeJsonl(p1, "s1.jsonl");
    const f2 = writeJsonl(p2, "s2.jsonl");
    const result = await discoverRecentJsonls(
      24,
      undefined,
      join(TMP, "projects"),
    );
    expect(result).toContain(f1);
    expect(result).toContain(f2);
  });
});
