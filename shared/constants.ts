/**
 * shared/constants.ts — Constantes compartidas entre scripts de observabilidad.
 *
 * Centraliza valores que aparecen en múltiples scripts para evitar
 * divergencias silenciosas cuando se necesita ajustar un umbral.
 */

/** Tolerancia en USD para considerar que el coste de una sesión ha drifteado. */
export const COST_EPSILON = 0.01;
