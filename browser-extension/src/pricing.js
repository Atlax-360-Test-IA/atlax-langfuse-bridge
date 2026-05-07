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
 * Precios: USD por millón de tokens (Anthropic API, mayo 2026).
 * Fuente: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * IMPORTANTE: las claves DEBEN ser tan específicas como sea necesario
 * para distinguir versiones con pricing distinto (ej. Opus 4.5+ vs 4.0/4.1).
 * El loop de match itera longest-first para evitar falsos positivos.
 */

export const MODEL_PRICING = {
  // Opus 4.5+: $5/$25
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
  // Opus 4.1 / 4.0: $15/$75 (legacy)
  "claude-opus-4-1": {
    input: 15,
    cacheWrite: 18.75,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  // Sonnet 4.x: $3/$15
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  // Haiku 4.5: $1/$5
  "claude-haiku-4-5": {
    input: 1,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    output: 5,
  },
  default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

// longest-key-first ordering — evita que claude-opus-4-7 matchee
// "claude-opus-4" antes que su entrada específica.
const PRICING_KEYS = Object.keys(MODEL_PRICING)
  .filter((k) => k !== "default")
  .sort((a, b) => b.length - a.length);

export function getPricing(model) {
  if (!model || typeof model !== "string") return MODEL_PRICING.default;
  for (const key of PRICING_KEYS) {
    if (model.includes(key)) return MODEL_PRICING[key];
  }
  return MODEL_PRICING.default;
}

export function estimateCost(model, inputTokens, outputTokens) {
  const p = getPricing(model);
  return (
    ((inputTokens || 0) * p.input + (outputTokens || 0) * p.output) / 1_000_000
  );
}
