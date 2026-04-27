/**
 * validators.js — Pure validation helpers used by content-isolated.js and
 * background.js. Extracted to a separate module so they can be unit-tested
 * without a Chrome extension environment.
 */

// Pragmatic email check: local@domain.tld — rejects non-email strings.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function validateUser(detail) {
  if (!detail || typeof detail !== "object") return null;
  const raw = detail.email;
  const email =
    typeof raw === "string" && raw.length <= 256 && EMAIL_RE.test(raw)
      ? raw
      : null;
  return email ? { email } : null;
}

export function validateTurn(detail) {
  if (!detail || typeof detail !== "object") return null;
  const model =
    typeof detail.model === "string" ? detail.model.slice(0, 128) : null;
  const inputTokens =
    typeof detail.inputTokens === "number" &&
    isFinite(detail.inputTokens) &&
    detail.inputTokens >= 0
      ? detail.inputTokens
      : 0;
  const outputTokens =
    typeof detail.outputTokens === "number" &&
    isFinite(detail.outputTokens) &&
    detail.outputTokens >= 0
      ? detail.outputTokens
      : 0;
  const surface =
    detail.surface === "chat" ||
    detail.surface === "projects" ||
    detail.surface === "unknown"
      ? detail.surface
      : "unknown";
  const platform =
    detail.platform === "app" || detail.platform === "browser"
      ? detail.platform
      : "browser";
  const conversationId =
    typeof detail.conversationId === "string" &&
    /^[0-9a-f-]{36}$/i.test(detail.conversationId)
      ? detail.conversationId
      : null;
  const url =
    typeof detail.url === "string" &&
    detail.url.startsWith("https://claude.ai/")
      ? detail.url.slice(0, 2048)
      : null;
  const timestamp =
    typeof detail.timestamp === "string" ? detail.timestamp.slice(0, 64) : null;
  return {
    model,
    inputTokens,
    outputTokens,
    surface,
    platform,
    conversationId,
    url,
    timestamp,
  };
}

export function isSafeHost(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return false;
  // Reject path traversal in the raw string before URL normalisation hides it.
  if (raw.includes("/../") || raw.includes("/..%2F") || raw.includes("%2F.."))
    return false;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    }
    return false;
  } catch {
    return false;
  }
}
