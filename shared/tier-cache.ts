/**
 * shared/tier-cache.ts — Cache SHA256 de tier por trace
 *
 * Evita reclasificar traces idénticos en sesiones del reconciler.
 * TTL 24h con cleanup bounded via setInterval().unref().
 *
 * Solo aplica a la clasificación de tier — no a billable usage,
 * que siempre se recalcula desde el JSONL.
 */

import { createHash } from "node:crypto";

export interface TierCacheEntry {
  tier: string;
  cachedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const MAX_ENTRIES = 10_000;

// Module-level singleton — vive mientras el proceso esté activo.
// En el hook Stop, el proceso termina al final; el cache solo ayuda al reconciler
// (proceso de larga duración que procesa múltiples sesiones por run).
const cache = new Map<string, TierCacheEntry>();

// Cleanup cada hora: elimina entradas expiradas. unref() para no bloquear exit.
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.cachedAt > TTL_MS) cache.delete(key);
    }
  },
  60 * 60 * 1000,
);
cleanupInterval.unref();

/**
 * Genera el hash SHA256 que identifica un trace para propósitos de tier.
 * Incluye session_id, modelos usados (ordenados) y tokens totales.
 */
export function traceHash(
  sessionId: string,
  models: string[],
  totalTokens: number,
): string {
  const canonical = JSON.stringify({
    s: sessionId,
    m: [...models].sort(),
    t: totalTokens,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Lee del cache. Retorna null si no existe o ha expirado.
 */
export function getCachedTier(hash: string): string | null {
  const entry = cache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(hash);
    return null;
  }
  return entry.tier;
}

/**
 * Guarda en cache. Si se alcanza MAX_ENTRIES, elimina la más antigua (FIFO).
 */
export function setCachedTier(hash: string, tier: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(hash, { tier, cachedAt: Date.now() });
}

/** Expone el tamaño del cache — útil para tests y métricas. */
export function cacheSize(): number {
  return cache.size;
}

/** Limpia el cache completo — solo para tests. */
export function clearCache(): void {
  cache.clear();
}
