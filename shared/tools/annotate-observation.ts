/**
 * shared/tools/annotate-observation.ts — AgentTool para anotar traces/observations
 *
 * Tier: full_llm — el valor de la anotación puede ser generativo (p.ej. un comment
 * razonado sobre por qué un trace es anómalo). No cacheable.
 *
 * Usa la API oficial de scores de Langfuse (/api/public/scores) en lugar de
 * patches de metadata: scores son el mecanismo canónico de anotación y aparecen
 * en filtros del UI.
 */

import { createScore, type ScoreBody } from "../langfuse-client";
import type { AgentTool } from "./types";

export interface AnnotateInput {
  traceId: string;
  /** Si se provee, el score se ata a la observation; si no, al trace completo. */
  observationId?: string;
  /** Nombre del score — convención: kebab-case, prefijo 'agent:' (p.ej. 'agent:anomaly'). */
  name: string;
  /** Valor: número para NUMERIC, string para CATEGORICAL, boolean para BOOLEAN. */
  value: number | string | boolean;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  comment?: string;
}

export interface AnnotateOutput {
  scoreId: string;
  traceId: string;
  observationId: string | null;
  name: string;
}

function inferDataType(value: unknown): "NUMERIC" | "CATEGORICAL" | "BOOLEAN" {
  if (typeof value === "number") return "NUMERIC";
  if (typeof value === "boolean") return "BOOLEAN";
  return "CATEGORICAL";
}

export const annotateObservation: AgentTool<AnnotateInput, AnnotateOutput> = {
  name: "annotate-observation",
  description:
    "Anota un trace u observation en Langfuse con un score (NUMERIC, CATEGORICAL o BOOLEAN). Preferir prefijo 'agent:' en el nombre para filtrado posterior.",
  tier: "full_llm",
  allowedAgentTypes: ["coordinator", "annotator"],
  inputSchema: {
    type: "object",
    properties: {
      traceId: {
        type: "string",
        description: "Trace ID destino. Obligatorio.",
      },
      observationId: {
        type: "string",
        description: "Opcional — si se provee, ata el score a la observation.",
      },
      name: {
        type: "string",
        description: "Nombre del score (kebab-case, prefijo 'agent:').",
      },
      value: {
        type: "string",
        description: "Valor del score. Puede ser número, string o boolean.",
      },
      dataType: {
        type: "string",
        enum: ["NUMERIC", "CATEGORICAL", "BOOLEAN"] as const,
        description: "Tipo del valor. Se infiere del tipo si se omite.",
      },
      comment: {
        type: "string",
        description: "Comment libre para contexto — ≤ 500 chars recomendado.",
      },
    },
    required: ["traceId", "name", "value"],
  },
  validate(raw) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "input must be an object" };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r["traceId"] !== "string" || r["traceId"].length === 0) {
      return {
        ok: false,
        error: "traceId is required and must be non-empty string",
      };
    }
    if (typeof r["name"] !== "string" || r["name"].length === 0) {
      return {
        ok: false,
        error: "name is required and must be non-empty string",
      };
    }
    if (
      r["value"] === undefined ||
      (typeof r["value"] !== "number" &&
        typeof r["value"] !== "string" &&
        typeof r["value"] !== "boolean")
    ) {
      return {
        ok: false,
        error: "value is required (number | string | boolean)",
      };
    }
    if (
      r["observationId"] !== undefined &&
      typeof r["observationId"] !== "string"
    ) {
      return { ok: false, error: "observationId must be string if provided" };
    }
    if (r["comment"] !== undefined && typeof r["comment"] !== "string") {
      return { ok: false, error: "comment must be string if provided" };
    }
    if (r["dataType"] !== undefined) {
      if (
        !["NUMERIC", "CATEGORICAL", "BOOLEAN"].includes(r["dataType"] as string)
      ) {
        return {
          ok: false,
          error: "dataType must be NUMERIC | CATEGORICAL | BOOLEAN",
        };
      }
    }
    return { ok: true, data: r as unknown as AnnotateInput };
  },
  async execute(input, ctx) {
    const body: ScoreBody = {
      traceId: input.traceId,
      observationId: input.observationId,
      name: input.name,
      value: input.value,
      dataType: input.dataType ?? inferDataType(input.value),
      comment: input.comment,
    };
    // Compose step budget with optional upstream signal — full_llm tools
    // benefit most from honoring budget because they may be slower.
    const stepSignal = AbortSignal.timeout(ctx.stepBudgetMs);
    const signal = ctx.signal
      ? AbortSignal.any([stepSignal, ctx.signal])
      : stepSignal;
    const res = await createScore(body, { signal });
    return {
      scoreId: res.id,
      traceId: input.traceId,
      observationId: input.observationId ?? null,
      name: input.name,
    };
  },
};
