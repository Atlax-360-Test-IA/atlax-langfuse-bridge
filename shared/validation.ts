/**
 * shared/validation.ts — Constantes de validación y helpers de seguridad.
 *
 * Centraliza regex y helpers que aparecen en múltiples scripts. Evita la
 * divergencia entre `validate-traces.ts`, `reconcile-traces.ts` y
 * `backfill-historical-traces.ts` cuando se necesita ajustar una validación.
 */

import * as path from "node:path";

/**
 * Allowlist de caracteres válidos para session IDs derivados de Claude Code.
 * Bound de 128 chars previene payloads de tamaño absurdo. Aplicable a:
 *  - sids derivados del nombre del fichero JSONL
 *  - traceIds construidos como `cc-${sid}`
 *  - cualquier valor que termine en path del filesystem
 */
export const SAFE_SID_RE = /^[0-9a-zA-Z_-]{1,128}$/;

/**
 * Resuelve `p` a un path absoluto y verifica que está confinado dentro de
 * `root`. Lanza si el path resuelto escapa del root (path traversal).
 *
 * Uso típico: `safeFilePath(path.join(os.homedir(), ".claude/projects"), event.transcript_path)`
 *
 * Implementación basada en `path.resolve` + `startsWith` con separador final
 * para evitar el clásico bypass `/safe-root-suffix` siendo prefix de `/safe-root`.
 */
export function safeFilePath(root: string, p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("safeFilePath: path must be a non-empty string");
  }
  const absRoot = path.resolve(root);
  const resolved = path.resolve(p);
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (resolved !== absRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`safeFilePath: path "${p}" escapes safe root "${absRoot}"`);
  }
  return resolved;
}
