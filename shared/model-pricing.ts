/**
 * shared/model-pricing.ts — Fuente única de pricing de modelos Claude.
 *
 * Todos los consumidores (hook Stop, reconciler, validator, LiteLLM) importan
 * de aquí. Cuando Anthropic ajusta precios, cambiar únicamente este fichero.
 *
 * Precios: USD por millón de tokens (Anthropic API, abril 2026).
 */

export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

/**
 * Devuelve el pricing para un model ID dado.
 * Usa substring matching para cubrir versiones (ej. "claude-opus-4-6" → "claude-opus-4").
 * Fallback a "default" (Sonnet pricing) si no hay match.
 */
// Sorted longest-key-first so "claude-haiku-4-5" matches before "claude-haiku-4"
// if a shorter key were ever added. Prevents spurious substring matches.
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
