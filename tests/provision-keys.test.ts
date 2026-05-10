/**
 * Unit tests para scripts/provision-keys.ts
 *
 * Cubre las funciones puras (`WORKLOADS`, `buildKeyPayload`) que construyen
 * el contrato HTTP contra LiteLLM. La función de subprocess + HTTP no se cubre
 * aquí (eso es smoke E2E). Esto valida que el shape del payload no se desvía
 * silenciosamente, y que los presupuestos de orvian-prod / atalaya-prod
 * (en producción 2026-05-10) se mantienen estables.
 *
 * Por qué importa: si `WORKLOADS[0].soft_budget` se cambia de 50 a 5 sin querer,
 * un dev podría disparar el budget en horas. Este test es el guard.
 */
import { describe, expect, test } from "bun:test";
import { WORKLOADS, buildKeyPayload } from "../scripts/provision-keys";

describe("WORKLOADS — virtual keys de producción (2026-05-10)", () => {
  test("expone exactamente los aliases orvian-prod y atalaya-prod", () => {
    const aliases = WORKLOADS.map((w) => w.key_alias).toSorted();
    expect(aliases).toEqual(["atalaya-prod", "orvian-prod"]);
  });

  test("orvian-prod tiene los límites comprometidos al equipo", () => {
    const orvian = WORKLOADS.find((w) => w.key_alias === "orvian-prod");
    expect(orvian).toBeDefined();
    expect(orvian!.soft_budget).toBe(50);
    expect(orvian!.budget_duration).toBe("30d");
    expect(orvian!.tpm_limit).toBe(200_000);
    expect(orvian!.rpm_limit).toBe(100);
    expect(orvian!.metadata.workload).toBe("orvian");
    expect(orvian!.metadata.env).toBe("prod");
    expect(orvian!.models).toEqual(["claude-sonnet-4-6"]);
  });

  test("atalaya-prod tiene los límites comprometidos al equipo", () => {
    const atalaya = WORKLOADS.find((w) => w.key_alias === "atalaya-prod");
    expect(atalaya).toBeDefined();
    expect(atalaya!.soft_budget).toBe(20);
    expect(atalaya!.budget_duration).toBe("30d");
    expect(atalaya!.tpm_limit).toBe(100_000);
    expect(atalaya!.rpm_limit).toBe(50);
    expect(atalaya!.metadata.workload).toBe("atalaya");
    expect(atalaya!.metadata.env).toBe("prod");
    expect(atalaya!.models).toEqual(["claude-sonnet-4-6"]);
  });

  test("todos los workloads usan modelo del MODEL_PRICING central (I-6)", async () => {
    const { MODEL_PRICING } = await import("../shared/model-pricing");
    const known = new Set(Object.keys(MODEL_PRICING));
    for (const wl of WORKLOADS) {
      for (const model of wl.models) {
        // claude-sonnet-4-6 → matchea "claude-sonnet-4" via substring
        const hasMatch = [...known].some(
          (key) => key !== "default" && model.includes(key),
        );
        expect(hasMatch).toBe(true);
      }
    }
  });
});

describe("buildKeyPayload — contrato POST /key/generate", () => {
  const sample = WORKLOADS[0]!;

  test("incluye los 7 campos requeridos por LiteLLM", () => {
    const payload = buildKeyPayload(sample);
    expect(payload).toHaveProperty("key_alias");
    expect(payload).toHaveProperty("soft_budget");
    expect(payload).toHaveProperty("budget_duration");
    expect(payload).toHaveProperty("tpm_limit");
    expect(payload).toHaveProperty("rpm_limit");
    expect(payload).toHaveProperty("metadata");
    expect(payload).toHaveProperty("models");
  });

  test("NO incluye max_budget (M3 decision — soft enforcement only)", () => {
    const payload = buildKeyPayload(sample);
    expect(payload).not.toHaveProperty("max_budget");
  });

  test("preserva valores numéricos sin coerción a string", () => {
    const payload = buildKeyPayload(sample) as Record<string, unknown>;
    expect(typeof payload["soft_budget"]).toBe("number");
    expect(typeof payload["tpm_limit"]).toBe("number");
    expect(typeof payload["rpm_limit"]).toBe("number");
    // No empty strings, no string-numbers
    expect(payload["soft_budget"]).not.toBe("50");
  });

  test("payload serializa a JSON válido", () => {
    const payload = buildKeyPayload(sample);
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["key_alias"]).toBe(sample.key_alias);
    expect(parsed["soft_budget"]).toBe(sample.soft_budget);
  });

  test("metadata es un objeto plano serializable", () => {
    const payload = buildKeyPayload(sample) as { metadata: unknown };
    expect(payload.metadata).toEqual(sample.metadata);
    // Verifica que sobrevive un round-trip JSON sin perder propiedades
    const round = JSON.parse(JSON.stringify(payload.metadata)) as {
      workload: string;
      env: string;
    };
    expect(round.workload).toBe(sample.metadata.workload);
    expect(round.env).toBe(sample.metadata.env);
  });
});
