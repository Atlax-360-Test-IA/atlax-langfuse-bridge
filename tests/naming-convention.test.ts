/**
 * Naming convention guard — Shared Platform v0.3 (D-009)
 *
 * Verifica que el naming GCP canónico atlax360-ai-<purpose>-<env> se mantiene
 * consistente en infra/, docs/operations/ y docs/audits/.
 *
 * Razón: tras PR #73 migrarmos del naming antiguo (`atlax-langfuse-prod`,
 * `atlax-langfuse-events`, etc.) al canónico (`atlax360-ai-langfuse-pro`,
 * `atlax360-ai-langfuse-events`). Sin un guard automático, una regresión
 * silenciosa puede colarse en un PR posterior y romper el cost report
 * agrupado por subfamilia AI Suite — perjudicando la narrativa que se
 * comunica al Comité Ejecutivo y Consejo.
 *
 * Falsos positivos legítimos:
 *   - El path local del repo `~/work/atlax-langfuse-bridge` (no es project ID GCP)
 *   - El nombre del systemd timer del developer `atlax-langfuse-reconcile.timer`
 *
 * Estos se whitelistean por contexto exacto.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Ficheros bajo control del naming canónico. NO incluye:
 * - tests/ (puede tener fixtures históricas con naming antiguo)
 * - docs/adr/ (immutable, ADRs viejos pueden tener naming antiguo)
 * - browser-extension/ (independiente del naming GCP)
 * - CHANGELOG.md (registro histórico)
 */
const FILES_UNDER_CONTROL = [
  "infra/provision-pro.sh",
  "infra/cloud-run.yaml",
  "docs/operations/cloud-run-deployment-plan.md",
  "docs/audits/shared-platform-validation-2026-05-09.md",
  "scripts/ops/PRO_ENV_VARS.md",
  "CLAUDE.md",
];

/**
 * Patrones del naming antiguo que NO deben aparecer en ficheros under control.
 * Usamos word boundaries para evitar matches parciales (ej. el path local
 * `~/work/atlax-langfuse-bridge` contiene `atlax-langfuse-` pero seguido de
 * `bridge`, no de `prod`).
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\batlax-langfuse-prod\b/,
    description: "GCP project ID antiguo (debe ser atlax360-ai-langfuse-pro)",
  },
  {
    pattern: /\batlax-langfuse-events\b/,
    description: "Bucket GCS antiguo (debe ser atlax360-ai-langfuse-events)",
  },
  {
    pattern: /\batlax-langfuse-media\b/,
    description: "Bucket GCS antiguo (debe ser atlax360-ai-langfuse-media)",
  },
  {
    pattern: /\batlax-langfuse-clickhouse-backups\b/,
    description:
      "Bucket GCS antiguo (debe ser atlax360-ai-langfuse-clickhouse-backups)",
  },
  {
    pattern: /\batlax-langfuse-pg-exports\b/,
    description:
      "Bucket GCS antiguo (debe ser atlax360-ai-langfuse-pg-exports)",
  },
];

/**
 * Patrón canónico esperado en fichero crítico.
 */
const REQUIRED_CANONICAL: Array<{
  file: string;
  pattern: RegExp;
  description: string;
}> = [
  {
    file: "infra/cloud-run.yaml",
    pattern: /atlax360-ai-langfuse-events/,
    description: "Bucket events canónico debe estar declarado",
  },
  {
    file: "infra/cloud-run.yaml",
    pattern: /atlax360-ai-langfuse-media/,
    description: "Bucket media canónico debe estar declarado",
  },
  {
    file: "infra/provision-pro.sh",
    pattern: /atlax360-ai-langfuse-pro/,
    description: "Project ID canónico en uso recomendado",
  },
  {
    file: "scripts/ops/PRO_ENV_VARS.md",
    pattern: /atlax360-ai-<purpose>-<env>/,
    description: "Convención naming documentada explícitamente",
  },
  {
    file: "CLAUDE.md",
    pattern: /atlax360-ai-<purpose>-<env>/,
    description: "Convención naming heredable a Claude Code",
  },
];

describe("Naming convention guard — Shared Platform v0.3 (D-009)", () => {
  describe("ningún fichero under control contiene naming antiguo", () => {
    for (const file of FILES_UNDER_CONTROL) {
      it(`${file} sin patterns prohibidos`, () => {
        const abs = join(REPO_ROOT, file);
        if (!existsSync(abs)) {
          throw new Error(
            `Fichero esperado no existe: ${file}. Si fue renombrado, actualizar FILES_UNDER_CONTROL.`,
          );
        }
        const content = readFileSync(abs, "utf-8");
        for (const { pattern, description } of FORBIDDEN_PATTERNS) {
          const match = content.match(pattern);
          expect(
            match,
            `${file}: encontrado "${match?.[0]}" — ${description}`,
          ).toBeNull();
        }
      });
    }
  });

  describe("ficheros críticos contienen el naming canónico requerido", () => {
    for (const { file, pattern, description } of REQUIRED_CANONICAL) {
      it(`${file}: ${description}`, () => {
        const abs = join(REPO_ROOT, file);
        const content = readFileSync(abs, "utf-8");
        expect(
          content.match(pattern),
          `${file}: falta el patrón canónico ${pattern} — ${description}`,
        ).not.toBeNull();
      });
    }
  });

  describe("dominio canónico atlax360.ai presente y atlax.ai (suelto) ausente", () => {
    /**
     * D-009 Shared Platform v0.3: el dominio canónico es atlax360.ai.
     * `atlax.ai` (sin 360) NO pertenece a Atlax 360.
     */
    it("CLAUDE.md menciona atlax360.ai como subdominio", () => {
      const content = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");
      expect(content).toContain("atlax360.ai");
    });

    it("ningún fichero under control usa <subdomain>.atlax.ai como apex sin prefijo 360", () => {
      /**
       * Patrón forbidden: subdominios de la forma `<x>.atlax.ai` que NO sean
       * `<x>.atlax360.ai`. Excluimos contextos legítimos:
       *
       * - Filenames: `atlax-ai-shared-platform.md` (legacy — el doc canónico
       *   vivió en Kairos como host transitorio hasta 2026-05-10; hoy en
       *   atlax-360-ai-suite/ai-suite-platform como docs/SPEC.md v0.4. La regex
       *   se mantiene porque los audit docs históricos aún lo referencian).
       * - Folder/path GCP: `atlax-ai` como folder name en GCP (legacy)
       * - Email: el `@atlax.ai` no aplica (no se usa en el repo)
       *
       * El patrón valida el caso real: subdominio `<algo>.atlax.ai` en config.
       */
      const SUBDOMAIN_FORBIDDEN = /\b[a-z][a-z0-9-]*\.atlax\.ai\b/;
      const VALID_OVERRIDE = /atlax360\.ai/;

      for (const file of FILES_UNDER_CONTROL) {
        const abs = join(REPO_ROOT, file);
        if (!existsSync(abs)) continue;
        const content = readFileSync(abs, "utf-8");

        // Buscamos línea por línea para excluir falsos positivos por contexto
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          // Sanitizar: eliminar primero todas las ocurrencias canónicas
          const sanitized = line.replace(/atlax360\.ai/g, "ATLAX360_OK");
          // Sanitizar referencias legacy a `atlax-ai-shared-platform` — aparece
          // en audit docs históricos de validación que son inmutables por diseño.
          // Doc canónico actual: atlax-360-ai-suite/ai-suite-platform/docs/SPEC.md
          const noKairosDocRef = sanitized.replace(
            /atlax-ai-shared-platform/g,
            "LEGACY_DOC_OK",
          );
          // Sanitizar ID de folder GCP `atlax-ai`
          const noFolderRef = noKairosDocRef.replace(
            /folder atlax-ai\b/g,
            "FOLDER_OK",
          );

          const match = noFolderRef.match(SUBDOMAIN_FORBIDDEN);
          if (match) {
            expect(
              null,
              `${file}:${i + 1}: encontrado subdominio "${match[0]}" — debe usar atlax360.ai (D-009 v0.3). Línea: ${line.trim().substring(0, 120)}`,
            ).not.toBeNull();
          }
        }
        // Si llegamos aquí sin throw, el fichero está limpio
        expect(true).toBe(true);
      }
    });
  });
});
