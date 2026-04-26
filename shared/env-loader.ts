/**
 * shared/env-loader.ts — Carga variables de entorno desde ~/.atlax-ai/reconcile.env.
 *
 * Patrón: solo setea variables que NO están ya en process.env, permitiendo
 * que el entorno de shell tenga prioridad. Silencia errores si el fichero
 * no existe (entornos con env vars ya configuradas via shell/systemd).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_PATH = join(homedir(), ".atlax-ai", "reconcile.env");

export function loadEnvFile(envPath: string = ENV_PATH): void {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // File not found or unreadable — rely on process.env
  }
}
