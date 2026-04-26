/**
 * pricing.js — Espejo JS de shared/model-pricing.ts para el service worker.
 *
 * Invariante I-6 (CLAUDE.md): la fuente de verdad es shared/model-pricing.ts.
 * Este fichero DEBE mantenerse en sincronía. tests/extension-pricing.test.ts
 * valida que no diverjan.
 *
 * Si Anthropic ajusta precios:
 *   1. Editar shared/model-pricing.ts
 *   2. Editar este fichero con los mismos valores
 *   3. bun test verificará la consistencia
 *
 * Precios: USD por millón de tokens (Anthropic API, abril 2026).
 */

export const MODEL_PRICING = {
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

export function getPricing(model) {
  if (!model) return MODEL_PRICING.default;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && model.includes(key)) return pricing;
  }
  return MODEL_PRICING.default;
}

export function estimateCost(model, inputTokens, outputTokens) {
  const p = getPricing(model);
  return (
    ((inputTokens || 0) * p.input + (outputTokens || 0) * p.output) / 1_000_000
  );
}
