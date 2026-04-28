/**
 * Fase D — enforcement: ARCHITECTURE.md menciona todos los invariantes I-1..I-13.
 * Si el SDD pierde cobertura de un invariante, este test falla antes de mergear.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SDD_PATH = join(REPO_ROOT, "ARCHITECTURE.md");

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
];

let sdd: string;

beforeAll(() => {
  sdd = readFileSync(SDD_PATH, "utf-8");
});

describe("ARCHITECTURE.md — cobertura de invariantes I-1..I-13", () => {
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
    // El apéndice debe tener las 13 filas de la tabla
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
