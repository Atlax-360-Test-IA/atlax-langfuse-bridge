/**
 * shared/tools/query-langfuse-trace.ts — AgentTool para buscar traces
 *
 * Tier: cached_llm — el output (metadata del trace) es determinista para el
 * mismo input, así que se integra con hash-cache SHA256.
 *
 * Casos de uso del coordinator:
 *   - "dame los últimos N traces del usuario X"
 *   - "busca traces del proyecto orvian en las últimas 24h"
 *   - "dame el trace cc-<session_id> completo con observaciones"
 */

import { getTrace, listTraces } from "../langfuse-client";
import type { LangfuseTrace } from "../langfuse-client";
import type { AgentTool } from "./types";
import { getCached, setCached, hashOf } from "../hash-cache";

export interface QueryTraceInput {
  /** Trace ID explícito. Si se provee, ignora el resto. */
  traceId?: string;
  /** Filtros para listado. Se ignoran si traceId está presente. */
  userId?: string;
  sessionId?: string;
  tags?: string[];
  fromTimestamp?: string;
  toTimestamp?: string;
  limit?: number;
}

export interface QueryTraceOutput {
  /** Siempre un array — vacío si nada matchea. */
  traces: Array<{
    id: string;
    name: string | null;
    timestamp: string;
    userId: string | null;
    tags: string[];
    metadata: Record<string, unknown> | null;
    estimatedCostUSD: number | null;
    turns: number | null;
  }>;
  fromCache: boolean;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export const queryLangfuseTrace: AgentTool<QueryTraceInput, QueryTraceOutput> =
  {
    name: "query-langfuse-trace",
    description:
      "Busca traces en Langfuse. Acepta traceId para lookup directo, o filtros (userId, tags, timeRange) para listado. Retorna metadata resumida sin observaciones completas.",
    tier: "cached_llm",
    allowedAgentTypes: ["coordinator", "trace-analyst"],
    inputSchema: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "Trace ID exacto (p.ej. 'cc-<session_id>').",
        },
        userId: {
          type: "string",
          description: "Filtrar por email/ID del dev.",
        },
        sessionId: {
          type: "string",
          description: "Filtrar por session_id de Claude Code.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags de filtrado, formato 'key:value' (p.ej. 'project:org/repo').",
        },
        fromTimestamp: {
          type: "string",
          description: "ISO-8601 inclusivo.",
        },
        toTimestamp: {
          type: "string",
          description: "ISO-8601 exclusivo.",
        },
        limit: {
          type: "number",
          description: "Máximo resultados (default 20, max 100).",
        },
      },
      required: [],
    },
    validate(raw) {
      if (typeof raw !== "object" || raw === null) {
        return { ok: false, error: "input must be an object" };
      }
      const r = raw as Record<string, unknown>;
      if (r.traceId !== undefined && typeof r.traceId !== "string") {
        return { ok: false, error: "traceId must be string" };
      }
      if (r.userId !== undefined && typeof r.userId !== "string") {
        return { ok: false, error: "userId must be string" };
      }
      if (r.sessionId !== undefined && typeof r.sessionId !== "string") {
        return { ok: false, error: "sessionId must be string" };
      }
      if (r.tags !== undefined && !isStringArray(r.tags)) {
        return { ok: false, error: "tags must be string[]" };
      }
      if (
        r.fromTimestamp !== undefined &&
        typeof r.fromTimestamp !== "string"
      ) {
        return { ok: false, error: "fromTimestamp must be string" };
      }
      if (r.toTimestamp !== undefined && typeof r.toTimestamp !== "string") {
        return { ok: false, error: "toTimestamp must be string" };
      }
      if (r.limit !== undefined) {
        if (typeof r.limit !== "number" || r.limit <= 0 || r.limit > 100) {
          return { ok: false, error: "limit must be number in [1, 100]" };
        }
      }
      return { ok: true, data: r as QueryTraceInput };
    },
    async execute(input, _ctx) {
      // Cache key: hash del input canónico. Tier cached_llm es cacheable.
      const cacheKey = `query-trace:${hashOf({
        t: input.traceId ?? null,
        u: input.userId ?? null,
        s: input.sessionId ?? null,
        g: [...(input.tags ?? [])].sort(),
        f: input.fromTimestamp ?? null,
        to: input.toTimestamp ?? null,
        l: input.limit ?? 20,
      })}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return { ...(JSON.parse(cached) as QueryTraceOutput), fromCache: true };
      }

      let traces: LangfuseTrace[];
      if (input.traceId) {
        const single = await getTrace(input.traceId);
        traces = single ? [single] : [];
      } else {
        const res = await listTraces({
          userId: input.userId,
          sessionId: input.sessionId,
          tags: input.tags,
          fromTimestamp: input.fromTimestamp,
          toTimestamp: input.toTimestamp,
          limit: input.limit ?? 20,
          orderBy: "timestamp.desc",
        });
        traces = res.data;
      }

      const result: QueryTraceOutput = {
        traces: traces.map((t) => ({
          id: t.id,
          name: t.name,
          timestamp: t.timestamp,
          userId: t.userId,
          tags: t.tags,
          metadata: t.metadata,
          estimatedCostUSD:
            typeof t.metadata?.estimatedCostUSD === "number"
              ? (t.metadata.estimatedCostUSD as number)
              : null,
          turns:
            typeof t.metadata?.turns === "number"
              ? (t.metadata.turns as number)
              : null,
        })),
        fromCache: false,
      };

      // Cache solo el payload sin el flag (para evitar cachear fromCache=true)
      const { fromCache: _drop, ...toCache } = result;
      setCached(cacheKey, JSON.stringify(toCache));
      return result;
    },
  };
