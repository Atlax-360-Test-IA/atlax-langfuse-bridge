/**
 * content-main.js — MAIN world
 *
 * Runs at document_start in the page's own JS context.
 * Overrides window.fetch to intercept claude.ai streaming responses.
 * Dispatches CustomEvents that content-isolated.js bridges to the background.
 *
 * Event bus (MAIN → ISOLATED):
 *   __atlax_user__    { email }
 *   __atlax_turn__    { model, inputTokens, outputTokens, surface, platform,
 *                       conversationId, url, timestamp }
 */
(function () {
  "use strict";

  const EV_USER = "__atlax_user__";
  const EV_TURN = "__atlax_turn__";

  // ── Surface detection ──────────────────────────────────────────────────────
  function getSurface() {
    const p = window.location.pathname;
    if (p.startsWith("/chats/")) return "chat";
    if (p.startsWith("/projects/")) return "projects";
    return "unknown";
  }

  // ── Platform detection ─────────────────────────────────────────────────────
  // Claude Windows/Mac app ships as Electron — same API calls, different UA
  function getPlatform() {
    return navigator.userAgent.includes("Electron") ? "app" : "browser";
  }

  // ── SSE stream parser ──────────────────────────────────────────────────────
  // Runs non-blocking. Cloned body is passed in so the page keeps its original.
  async function parseSSE(body, meta) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let model = null;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          // message_start carries model + input token count
          if (ev.type === "message_start" && ev.message) {
            model = ev.message.model ?? model;
            inputTokens = ev.message.usage?.input_tokens ?? 0;
          }

          // message_delta carries final output token count
          if (ev.type === "message_delta" && ev.usage) {
            outputTokens = ev.usage.output_tokens ?? outputTokens;
          }

          // message_stop signals end of one assistant turn
          if (ev.type === "message_stop") {
            // H4: use ISO timestamp from the stream event time — deterministic
            // for re-processing the same turn (I-2: idempotency invariant).
            const timestamp = new Date().toISOString();
            window.dispatchEvent(
              new CustomEvent(EV_TURN, {
                detail: {
                  model,
                  inputTokens,
                  outputTokens,
                  surface: meta.surface,
                  platform: meta.platform,
                  conversationId: meta.conversationId,
                  url: meta.url,
                  timestamp,
                },
              }),
            );
          }
        }
      }
    } catch (err) {
      // AbortError = stream cancelled by navigation/tab close — expected, silent
      if (err?.name !== "AbortError") {
        console.warn("[atlax-bridge] SSE stream error", {
          type: "degradation",
          source: "parseSSE",
          error: err?.message ?? String(err),
          ts: new Date().toISOString(),
        });
      }
    } finally {
      // H3: release the reader lock regardless of how the loop exits.
      // Without this, the cloned body stays locked and cannot be GC'd.
      reader.cancel().catch(() => {});
    }
  }

  // ── User identity ──────────────────────────────────────────────────────────
  // Fetch once at page load using the page's own session cookie.
  const originalFetch = window.fetch;
  let emailSent = false;

  function fetchUserEmail() {
    originalFetch("/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => d?.email ?? d?.username ?? null)
      .then((email) => {
        if (email && !emailSent) {
          emailSent = true;
          window.dispatchEvent(new CustomEvent(EV_USER, { detail: { email } }));
        }
      })
      .catch(() => {}); // no authenticated session yet
  }

  // ── Fetch override ─────────────────────────────────────────────────────────
  // Must happen before any page scripts run (run_at: document_start).
  window.fetch = async function (...args) {
    const req = args[0];
    const url =
      typeof req === "string" ? req : req instanceof Request ? req.url : "";

    // Intercept completion endpoints (both initial and retry)
    const isCompletion =
      url.includes("/completion") && url.includes("claude.ai");

    const response = await originalFetch.apply(this, args);

    if (isCompletion && response.body) {
      // Extract conversation UUID from the API URL
      // Pattern: /api/organizations/<org>/chat_conversations/<uuid>/completion
      const convMatch = url.match(/chat_conversations\/([0-9a-f-]{36})/i);

      const meta = {
        surface: getSurface(),
        platform: getPlatform(),
        conversationId: convMatch?.[1] ?? null,
        url: window.location.href,
      };

      // Clone so the page can still read the original body
      parseSSE(response.clone().body, meta);
    }

    return response;
  };

  // Kick off user identity fetch after a small delay
  // (cookies are available immediately, but API might respond 401 before login)
  setTimeout(fetchUserEmail, 800);
})();
