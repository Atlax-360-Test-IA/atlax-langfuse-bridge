/**
 * shared/model-pricing.ts — Fuente única de pricing de modelos Claude.
 *
 * Todos los consumidores (hook Stop, reconciler, validator, LiteLLM) importan
 * de aquí. Cuando Anthropic ajusta precios, cambiar únicamente este fichero.
 *
 * Precios: USD por millón de tokens (Anthropic API, mayo 2026).
 * Fuente: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Cache write se modela como 5-min (1.25× input). Si en el futuro hay que
 * distinguir 5-min vs 1-h, añadir un segundo campo cacheWrite1h.
 *
 * IMPORTANTE: las claves del MODEL_PRICING deben ser **lo más específicas**
 * posibles para que el substring match no produzca falsos positivos. Por
 * ejemplo, "claude-opus-4" matchearía Opus 4, 4.1, 4.5, 4.6, 4.7 dándoles
 * todos el pricing del Opus 4 legacy ($15/$75). Las versiones modernas
 * tienen pricing distinto y deben tener entradas separadas.
 */

export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.5+ (mayo 2026): $5/$25 input/output, $0.50 cache read, $6.25 cache write 5min
  "claude-opus-4-7": {
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-6": {
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-5": {
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
  },
  // Opus 4.1 / 4.0 (legacy): $15/$75
  "claude-opus-4-1": {
    input: 15,
    cacheWrite: 18.75,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  // Sonnet 4.x (4.0/4.5/4.6 mismo precio): $3/$15
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  // Haiku 4.5: $1/$5
  "claude-haiku-4-5": {
    input: 1,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    output: 5,
  },
  // Default fallback: Sonnet 4 pricing (modelo más extendido)
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

/**
 * Devuelve el pricing para un model ID dado.
 * Usa substring matching para cubrir versiones de fecha (ej.
 * "claude-haiku-4-5-20251001" → "claude-haiku-4-5").
 * Las claves se ordenan longest-first para evitar que "claude-opus-4-7"
 * matchee "claude-opus-4" antes que su entrada específica.
 * Fallback a "default" (Sonnet pricing) si no hay match.
 */
const PRICING_KEYS = Object.keys(MODEL_PRICING)
  .filter((k) => k !== "default")
  .sort((a, b) => b.length - a.length);

export function getPricing(model: string): ModelPricing {
  if (typeof model !== "string") return MODEL_PRICING["default"]!;
  for (const key of PRICING_KEYS) {
    if (model.includes(key)) return MODEL_PRICING[key]!;
  }
  return MODEL_PRICING["default"]!;
}
