/**
 * shared/jsonl-discovery.ts — Discovers recent Claude Code JSONL session files.
 *
 * Scans ~/.claude/projects/**\/*.jsonl and returns paths whose mtime falls
 * within the requested window. Used by reconcile-traces and validate-traces.
 *
 * onError: optional callback for each filesystem error encountered. When
 * omitted errors are silenced (validate-traces behaviour). When provided,
 * callers can emit degradation entries (reconcile-traces behaviour).
 */

import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export async function discoverRecentJsonls(
  windowHours: number,
  onError?: (source: string, err: unknown) => void,
  root: string = join(homedir(), ".claude", "projects"),
): Promise<string[]> {
  const cutoff = Date.now() - windowHours * 3_600_000;
  const found: string[] = [];

  let topDirs: string[];
  try {
    topDirs = await readdir(root);
  } catch (err) {
    onError?.("discoverJsonls:readdir-root", err);
    return [];
  }

  for (const d of topDirs) {
    const projectDir = join(root, d);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch (err) {
      onError?.("discoverJsonls:readdir-project", err);
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(projectDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) found.push(p);
      } catch (err) {
        onError?.("discoverJsonls:stat", err);
      }
    }
  }
  return found.sort();
}
