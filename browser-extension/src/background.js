/**
 * background.js — Service Worker
 *
 * Receives CONVERSATION_TURN messages from content scripts and sends
 * trace + generation events to the configured Langfuse instance.
 *
 * Trace model:
 *   - One trace per conversation (id = "claude-web-{conversationId}")
 *   - One generation per assistant turn (id = "claude-web-{convId}-{turnIdx}")
 *   - Traces are upserted on each turn (Langfuse deduplicates by id)
 */

// ── Model pricing table (USD / million tokens) ─────────────────────────────
const PRICING = {
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const entry = Object.entries(PRICING).find(([k]) => model?.includes(k));
  if (!entry) return 0;
  const p = entry[1];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ── In-memory user cache ───────────────────────────────────────────────────
let cachedEmail = "unknown";

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "USER_INFO") {
    cachedEmail = msg.email || cachedEmail;
    return;
  }

  if (msg.type === "CONVERSATION_TURN") {
    handleTurn(msg);
    return;
  }

  if (msg.type === "TEST_CONNECTION") {
    testConnection().then(sendResponse);
    return true; // async response
  }
});

// ── Core: send turn to Langfuse ────────────────────────────────────────────
async function handleTurn(turn) {
  const cfg = await chrome.storage.sync.get([
    "langfuseHost",
    "publicKey",
    "secretKey",
  ]);
  if (!cfg.publicKey || !cfg.secretKey || !cfg.langfuseHost) return;

  const userId = turn.userEmail || cachedEmail;
  const convId = turn.conversationId || crypto.randomUUID();
  const traceId = `claude-web-${convId}`;
  const now = turn.timestamp || new Date().toISOString();
  const cost = estimateCost(turn.model, turn.inputTokens, turn.outputTokens);

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
        tags: [
          `surface:${turn.surface}`,
          `platform:${turn.platform}`,
          "entrypoint:claude-ai",
        ],
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
        id: `${traceId}-${Date.now()}`,
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
    await fetch(`${host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${creds}`,
      },
      body: JSON.stringify({ batch }),
    });
  } catch {
    // Silently ignore network errors — extension must never disrupt browsing
  }
}

// ── Connection test (called from popup) ───────────────────────────────────
async function testConnection() {
  const cfg = await chrome.storage.sync.get([
    "langfuseHost",
    "publicKey",
    "secretKey",
  ]);
  if (!cfg.publicKey || !cfg.secretKey || !cfg.langfuseHost) {
    return { ok: false, error: "Credenciales no configuradas" };
  }
  try {
    const host = cfg.langfuseHost.replace(/\/$/, "");
    const res = await fetch(`${host}/api/public/health`);
    const body = await res.json();
    if (res.ok && body.status === "OK") {
      return { ok: true, version: body.version };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
