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

import { stat, readdir } from "node:fs/promises";
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
    // Promise.allSettled defensivo: aunque cada callback tiene try/catch local,
    // un fallo no anticipado (e.g. found.push contra un Array.length limit) no
    // debe abortar el scan completo. Las rejected entries se reportan vía onError
    // sin interrumpir las fulfilled.
    const statPromises = files
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (f) => {
        const p = join(projectDir, f);
        try {
          const st = await stat(p);
          if (st.mtimeMs >= cutoff) found.push(p);
        } catch (err) {
          onError?.("discoverJsonls:stat", err);
        }
      });
    const settled = await Promise.allSettled(statPromises);
    for (const r of settled) {
      if (r.status === "rejected") {
        onError?.("discoverJsonls:stat-unexpected", r.reason);
      }
    }
  }
  return found.sort();
}
