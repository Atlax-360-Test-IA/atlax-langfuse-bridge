#!/usr/bin/env bun
/**
 * detect-tier.ts — Write ~/.atlax-ai/tier.json with deterministic billing
 * tier for the current Claude Code session.
 *
 * Tier resolution order (first match wins):
 *   1. CLAUDE_CODE_USE_VERTEX=1 | true     → vertex-gcp
 *   2. ANTHROPIC_API_KEY set                → api-direct
 *   3. ~/.claude/.credentials.json exists   → seat-team   (OAuth session)
 *   4. otherwise                            → unknown
 *
 * The output file is the source of truth read by hooks/langfuse-sync.ts.
 * Called by the Claude Code statusline command on every prompt tick — cheap
 * (<5ms) and writes atomically only when the tier actually changes.
 *
 * Usage:
 *   bun run scripts/detect-tier.ts         # write + print JSON
 *   bun run scripts/detect-tier.ts --label # write + print short status label
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BillingTier = "vertex-gcp" | "api-direct" | "seat-team" | "unknown";

export type TierSource = "env-vertex" | "env-api-key" | "oauth" | "none";

export interface TierFile {
  tier: BillingTier;
  source: TierSource;
  account: string | null;
  detectedAt: string;
}

const TIER_DIR = join(homedir(), ".atlax-ai");
const TIER_PATH = join(TIER_DIR, "tier.json");

export function detectTier(): TierFile {
  const now = new Date().toISOString();

  // 1. Vertex
  const vertex = process.env.CLAUDE_CODE_USE_VERTEX;
  if (vertex === "1" || vertex === "true") {
    return {
      tier: "vertex-gcp",
      source: "env-vertex",
      account: process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null,
      detectedAt: now,
    };
  }

  // 2. API direct
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      tier: "api-direct",
      source: "env-api-key",
      account: null,
      detectedAt: now,
    };
  }

  // 3. OAuth session (Claude Code CLI)
  // I-8: only check existence — never read or parse credentials content.
  const oauth = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(oauth)) {
    return {
      tier: "seat-team",
      source: "oauth",
      account: null,
      detectedAt: now,
    };
  }

  return { tier: "unknown", source: "none", account: null, detectedAt: now };
}

export function writeIfChanged(tier: TierFile): boolean {
  if (!existsSync(TIER_DIR)) mkdirSync(TIER_DIR, { recursive: true });

  // Only rewrite when tier or source changes (detectedAt churn is not a
  // meaningful change). Atomic write via rename.
  let previous: TierFile | null = null;
  if (existsSync(TIER_PATH)) {
    try {
      previous = JSON.parse(readFileSync(TIER_PATH, "utf-8")) as TierFile;
    } catch {
      previous = null;
    }
  }

  const unchanged =
    previous &&
    previous.tier === tier.tier &&
    previous.source === tier.source &&
    previous.account === tier.account;

  if (unchanged) return false;

  const tmp = `${TIER_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tier, null, 2));
  renameSync(tmp, TIER_PATH);
  return true;
}

export function labelFor(t: TierFile): string {
  const icons: Record<BillingTier, string> = {
    "vertex-gcp": "☁ vertex",
    "api-direct": "⚡ api",
    "seat-team": "◆ seat",
    unknown: "? tier",
  };
  const icon = icons[t.tier];
  return t.account ? `${icon} ${t.account}` : icon;
}

function main() {
  const tier = detectTier();
  writeIfChanged(tier);

  if (process.argv.includes("--label")) {
    process.stdout.write(labelFor(tier));
  } else {
    process.stdout.write(JSON.stringify(tier, null, 2) + "\n");
  }
}

// Only run main() when invoked directly, not when imported.
if (import.meta.main) main();
