/**
 * shared/hash-cache.ts — Content-addressed cache genérico con TTL
 *
 * Renombrado desde `tier-cache.ts` cuando se generalizó a múltiples consumers
 * (tier classification + tool outputs). El hash es responsabilidad del caller —
 * el módulo solo gestiona el ciclo de vida (TTL, evicción FIFO).
 *
 * Bounded: MAX_ENTRIES=10_000, TTL=24h, cleanup horario via setInterval().unref().
 */

import { createHash } from "node:crypto";

export interface HashCacheEntry {
  value: string;
  cachedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const MAX_ENTRIES = 10_000;

const cache = new Map<string, HashCacheEntry>();

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
 * Hash SHA256 canónico de un trace para clasificación de tier.
 * Conveniencia para el caso de uso original — los callers genéricos usan
 * `hashOf()` con sus propios inputs.
 */
export function traceHash(
  sessionId: string,
  models: string[],
  totalTokens: number,
): string {
  return hashOf({
    s: sessionId,
    m: [...models].sort(),
    t: totalTokens,
  });
}

/**
 * Hash SHA256 sobre la representación JSON canónica de un objeto arbitrario.
 * El caller es responsable de proporcionar objetos con orden de claves estable
 * (preferiblemente ordenadas) para que entradas equivalentes hasheen igual.
 */
export function hashOf(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Lee del cache. Retorna null si no existe o ha expirado.
 */
export function getCached(hash: string): string | null {
  const entry = cache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(hash);
    return null;
  }
  return entry.value;
}

/**
 * Guarda en cache. Evicción FIFO si se alcanza MAX_ENTRIES.
 */
export function setCached(hash: string, value: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(hash, { value, cachedAt: Date.now() });
}

/** Tamaño actual del cache — útil para tests y métricas. */
export function cacheSize(): number {
  return cache.size;
}

/** Limpia el cache completo — solo para tests. */
export function clearCache(): void {
  cache.clear();
}
