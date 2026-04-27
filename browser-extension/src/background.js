/**
 * background.js — Service Worker (MV3, ESM)
 *
 * Receives CONVERSATION_TURN messages from content scripts and sends
 * trace + generation events to the configured Langfuse instance.
 *
 * Trace model:
 *   - One trace per conversation (id = "claude-web-{conversationId}")
 *   - One generation per assistant turn (id = "claude-web-{convId}-{ts}")
 *   - Traces are upserted on each turn (Langfuse deduplicates by id)
 *
 * Pricing alineado con shared/model-pricing.ts (I-6 del CLAUDE.md).
 */

import { estimateCost } from "./pricing.js";
import { emitDegradation } from "./degradation.js";
import { isSafeHost } from "./validators.js";

// ── In-memory user cache ───────────────────────────────────────────────────
let cachedEmail = "unknown";

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "USER_INFO") {
    cachedEmail = msg.email || cachedEmail;
    return;
  }

  if (msg.type === "CONVERSATION_TURN") {
    handleTurn(msg).catch((err) => emitDegradation("handleTurn", err));
    return;
  }

  if (msg.type === "TEST_CONNECTION") {
    testConnection().then(sendResponse);
    return true; // async response
  }
});

// ── Storage helpers ────────────────────────────────────────────────────────
// langfuseHost + publicKey: non-sensitive, can sync across devices.
// secretKey: credential — stays device-local only (chrome.storage.local).
async function getConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(["langfuseHost", "publicKey"]),
    chrome.storage.local.get(["secretKey"]),
  ]);
  return { ...sync, ...local };
}

// ── Core: send turn to Langfuse ────────────────────────────────────────────
async function handleTurn(turn) {
  let cfg;
  try {
    cfg = await getConfig();
  } catch (err) {
    await emitDegradation("handleTurn:storage-get", err);
    return;
  }
  if (!cfg.publicKey || !cfg.secretKey || !cfg.langfuseHost) return;
  if (!isSafeHost(cfg.langfuseHost)) {
    await emitDegradation(
      "handleTurn:unsafe-host",
      new Error(`Blocked unsafe langfuseHost: ${cfg.langfuseHost}`),
    );
    return;
  }

  const userId = turn.userEmail || cachedEmail;
  const convId = turn.conversationId || crypto.randomUUID();
  const traceId = `claude-web-${convId}`;
  const now = turn.timestamp || new Date().toISOString();
  const cost = estimateCost(turn.model, turn.inputTokens, turn.outputTokens);

  const tags = [
    `surface:${turn.surface}`,
    `platform:${turn.platform}`,
    "entrypoint:claude-ai",
    `tier:${turn.platform === "app" ? "claude-app" : "claude-web"}`,
    "tier-source:browser-extension",
  ];

  const batch = [
    // Upsert the trace (same id = same trace in Langfuse, safe to repeat)
    {
      id: crypto.randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        name: "claude-ai-session",
        userId,
        sessionId: convId,
        tags,
        metadata: {
          surface: turn.surface,
          platform: turn.platform,
          conversationId: convId,
          model: turn.model,
          conversationUrl: turn.url,
        },
      },
    },
    // One generation per assistant turn
    {
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        id: `${traceId}-${now}`,
        traceId,
        name: turn.model || "claude-web",
        model: turn.model || "unknown",
        usage: {
          input: turn.inputTokens,
          output: turn.outputTokens,
          unit: "TOKENS",
        },
        costDetails: { estimatedUSD: Number(cost.toFixed(6)) },
        metadata: {
          surface: turn.surface,
          platform: turn.platform,
          estimatedCostUSD: cost,
        },
      },
    },
  ];

  const host = cfg.langfuseHost.replace(/\/$/, "");
  const creds = btoa(`${cfg.publicKey}:${cfg.secretKey}`);

  try {
    const res = await fetch(`${host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${creds}`,
      },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await emitDegradation(
        "handleTurn:ingestion-http",
        new Error(`HTTP ${res.status}`),
      );
    }
  } catch (err) {
    await emitDegradation("handleTurn:ingestion-fetch", err);
  }
}

// ── Connection test (called from popup) ───────────────────────────────────
async function testConnection() {
  let cfg;
  try {
    cfg = await getConfig();
  } catch (err) {
    await emitDegradation("testConnection:storage-get", err);
    return { ok: false, error: "storage no disponible" };
  }
  if (!cfg.publicKey || !cfg.secretKey || !cfg.langfuseHost) {
    return { ok: false, error: "Credenciales no configuradas" };
  }
  if (!isSafeHost(cfg.langfuseHost)) {
    return {
      ok: false,
      error: "Host no permitido (debe ser HTTPS o localhost)",
    };
  }
  try {
    const host = cfg.langfuseHost.replace(/\/$/, "");
    const res = await fetch(`${host}/api/public/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json();
    if (res.ok && body.status === "OK") {
      return { ok: true, version: body.version };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    await emitDegradation("testConnection:fetch", err);
    return { ok: false, error: err.message };
  }
}
