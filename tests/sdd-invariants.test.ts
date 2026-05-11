/**
 * Fase D — enforcement: ARCHITECTURE.md menciona todos los invariantes I-1..I-15.
 * Si el SDD pierde cobertura de un invariante, este test falla antes de mergear.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SDD_PATH = join(REPO_ROOT, "ARCHITECTURE.md");
const README_PATH = join(REPO_ROOT, "README.md");

const INVARIANTS: Array<{ id: string; keywords: string[] }> = [
  { id: "I-1", keywords: ["exit 0", "hook nunca"] },
  { id: "I-2", keywords: ["cc-${session_id}", "upsert"] },
  { id: "I-3", keywords: ["primer JSONL entry", "Stop event"] },
  { id: "I-4", keywords: ["UNION", "upsert"] },
  { id: "I-5", keywords: ["WINDOW_HOURS", "24h"] },
  { id: "I-6", keywords: ["MODEL_PRICING", "model-pricing.ts"] },
  { id: "I-7", keywords: ["tier.json", "~/.atlax-ai"] },
  { id: "I-8", keywords: ["credentials.json", "existencia"] },
  { id: "I-9", keywords: ["I-9", "generation"] },
  { id: "I-10", keywords: ["MCP_AGENT_TYPE", "allowlist"] },
  { id: "I-11", keywords: ["classifyDrift", "shared/drift.ts"] },
  { id: "I-12", keywords: ["process.env", "per-key"] },
  { id: "I-13", keywords: ["Cloud Run", "reconciler"] },
  { id: "I-14", keywords: ["paralelismo", "doble-check"] },
  { id: "I-15", keywords: ["SAFE_SID_RE", "validar IDs"] },
];

let sdd: string;

beforeAll(() => {
  sdd = readFileSync(SDD_PATH, "utf-8");
});

describe("ARCHITECTURE.md — cobertura de invariantes I-1..I-14", () => {
  for (const { id, keywords } of INVARIANTS) {
    it(`${id} está documentado en ARCHITECTURE.md`, () => {
      // El propio marcador I-N debe aparecer
      expect(sdd).toContain(id);

      // Al menos una keyword semántica adicional para el invariante
      const found = keywords.some((kw) => sdd.includes(kw));
      expect(
        found,
        `${id}: ninguna de las keywords [${keywords.join(", ")}] aparece en ARCHITECTURE.md`,
      ).toBe(true);
    });
  }

  it("Apéndice A contiene una fila por cada invariante", () => {
    // El apéndice debe tener las 14 filas de la tabla
    for (const { id } of INVARIANTS) {
      expect(sdd).toContain(id);
    }
  });

  it("ARCHITECTURE.md tiene al menos 14 secciones §", () => {
    const sections = sdd.match(/^## §\d+/gm) ?? [];
    expect(sections.length).toBeGreaterThanOrEqual(14);
  });

  it("ARCHITECTURE.md tiene Apéndice A", () => {
    expect(sdd).toContain("Apéndice A");
  });
});

// ─── Métricas: README y ARCHITECTURE deben citar el mismo número de tests ────

describe("Métricas — README.md y ARCHITECTURE.md consistentes", () => {
  it("README.md y ARCHITECTURE.md citan el mismo número de tests", () => {
    const readme = readFileSync(README_PATH, "utf-8");

    // README header: "**vX.Y.Z · NNNN tests / MMMM expects / 0 fallos**"
    const readmeMatch = readme.match(
      /\*\*v\d+\.\d+\.\d+ · (\d+) tests \/ (\d+) expects \/ 0 fallos\*\*/,
    );
    expect(
      readmeMatch,
      "README.md debe tener un header tipo '**vX.Y.Z · NNNN tests / MMMM expects / 0 fallos**'",
    ).not.toBeNull();

    // ARCHITECTURE §10: "**Estado actual**: NNNN tests / MMMM expects / KK ficheros / 0 fallos"
    const sddMatch = sdd.match(
      /\*\*Estado actual\*\*: (\d+) tests \/ (\d+) expects \/ (\d+) ficheros \/ 0 fallos/,
    );
    expect(
      sddMatch,
      "ARCHITECTURE.md §10 debe tener un header tipo '**Estado actual**: NNNN tests / MMMM expects / KK ficheros / 0 fallos'",
    ).not.toBeNull();

    expect(readmeMatch![1]).toBe(sddMatch![1]); // tests
    expect(readmeMatch![2]).toBe(sddMatch![2]); // expects
  });

  it("README.md no menciona conteos obsoletos de tests inline", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    // Patrones rotos del pasado: "818 tests", "(1053 tests / 0 fallos)"
    // Hardcodear conteos en comments inline lleva a drift inmediato.
    const obsoletePatterns = [
      /\(\d+ tests \/ \d+ fallos\)/, // comments tipo "(818 tests / 0 fallos)"
      /typecheck \+ \d+ tests\)/, // "typecheck + 818 tests)"
    ];
    for (const pattern of obsoletePatterns) {
      expect(
        readme.match(pattern),
        `README.md contiene conteo obsoleto inline (pattern: ${pattern}). Usar referencias genéricas — el header del README + §10 de ARCHITECTURE.md son la única fuente de verdad.`,
      ).toBeNull();
    }
  });
});
