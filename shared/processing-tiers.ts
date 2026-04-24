/**
 * shared/processing-tiers.ts — Clasificación de hooks y tools por coste
 *
 * Inspirado en el patrón Orvian `tier-system-bulk-processing.md#1`. Cada hook
 * o tool del bridge declara su tier. El tier determina:
 *
 *   - Si el output es cacheable (hash-cache.ts solo aplica a `cached_llm`).
 *   - Si el consumer puede ejecutarlo en batch sin budget check.
 *   - Visibilidad operacional (logging/metrics) — hooks `full_llm` merecen audit
 *     detallado; `deterministic` no.
 *
 * Hoy todos los hooks del bridge son `deterministic`. Este módulo define la
 * taxonomía para cuando se introduzcan tools agénticos (ver backlog item #3
 * — hook adapter como AgentTool).
 */

export type ProcessingTier = "deterministic" | "cached_llm" | "full_llm";

export interface TierMetadata {
  /** El output es idéntico para el mismo input — apto para content-addressed cache. */
  cacheable: boolean;
  /** Coste por ejecución en USD (orden de magnitud, no exacto). */
  costOrderUSD: number;
  /** Latencia p99 aproximada en ms — usada para derivar chunk size en batch. */
  latencyP99Ms: number;
  /** Si true, el consumer debe emitir audit entry con I/O completo. */
  requiresDetailedAudit: boolean;
}

export const TIER_METADATA: Record<ProcessingTier, TierMetadata> = {
  deterministic: {
    cacheable: false, // no sirve cachear algo que cuesta 0 y es rápido
    costOrderUSD: 0,
    latencyP99Ms: 500,
    requiresDetailedAudit: false,
  },
  cached_llm: {
    cacheable: true,
    costOrderUSD: 0.02,
    latencyP99Ms: 5_000,
    requiresDetailedAudit: true,
  },
  full_llm: {
    cacheable: false, // output generativo — misma entrada puede dar distintas salidas
    costOrderUSD: 0.05,
    latencyP99Ms: 25_000,
    requiresDetailedAudit: true,
  },
};

/**
 * Mapa declarativo de hooks/tools del bridge a su tier.
 *
 * Añadir aquí cada hook o tool nuevo. El nombre debe coincidir con el source
 * usado en `emitDegradation()` o con el `name` de la tool.
 */
export const HOOK_TIER_MAP: Record<string, ProcessingTier> = {
  // Hook Stop — parsea JSONL, agrega usage, envía a Langfuse. Zero LLM.
  "langfuse-sync": "deterministic",

  // Reconciler — escanea JSONL local, detecta drift, re-ejecuta el hook. Zero LLM.
  "reconcile-traces": "deterministic",

  // Validator — compara JSONL vs Langfuse. Zero LLM.
  "validate-traces": "deterministic",

  // Detect tier — lee env vars + ~/.claude/.credentials.json exists. Zero LLM.
  "detect-tier": "deterministic",

  // Provision keys — llama a LiteLLM admin API. Zero LLM.
  "provision-keys": "deterministic",

  // Futuro (backlog #3): tools agénticos para análisis de traces.
  // "query-langfuse-trace": "cached_llm",
  // "annotate-observation": "full_llm",
};

/**
 * Lookup de tier. Retorna `deterministic` como default conservador.
 */
export function getTier(hookName: string): ProcessingTier {
  return HOOK_TIER_MAP[hookName] ?? "deterministic";
}

/**
 * Lookup de metadata completa.
 */
export function getTierMetadata(hookName: string): TierMetadata {
  return TIER_METADATA[getTier(hookName)];
}
