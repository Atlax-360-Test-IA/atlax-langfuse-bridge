/**
 * degradation.js — Telemetry de degradación para el service worker.
 *
 * Análogo a shared/degradation.ts del bridge. Service workers no tienen
 * stderr; las entradas se persisten en chrome.storage.local con key
 * "degradationLog" (rolling buffer de las últimas 50). Útil para diagnóstico
 * desde el popup o devtools sin bloquear la captura.
 *
 * Estructura igual que DegradationEntry del bridge:
 *   { type: "degradation", source, error, ts }
 */

const MAX_ENTRIES = 50;
const STORAGE_KEY = "degradationLog";

export async function emitDegradation(source, err) {
  const entry = {
    type: "degradation",
    source,
    error: err instanceof Error ? err.message : String(err),
    ts: new Date().toISOString(),
  };

  // Console (devtools del service worker) — siempre
  // eslint-disable-next-line no-console
  console.warn("[atlax-extension]", JSON.stringify(entry));

  // Persistencia (rolling buffer) — best-effort, nunca lanza
  try {
    const cur = await chrome.storage.local.get(STORAGE_KEY);
    const log = Array.isArray(cur[STORAGE_KEY]) ? cur[STORAGE_KEY] : [];
    log.push(entry);
    while (log.length > MAX_ENTRIES) log.shift();
    await chrome.storage.local.set({ [STORAGE_KEY]: log });
  } catch {
    // Si chrome.storage falla, ya lo logueamos por consola
  }
}
