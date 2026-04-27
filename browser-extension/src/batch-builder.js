/**
 * batch-builder.js — Pure batch construction for Langfuse ingestion.
 *
 * No chrome.* dependencies — fully testable in Bun/Node.
 * Consumed by background.js and its test suite.
 */

import { estimateCost } from "./pricing.js";

/**
 * @typedef {{ model: string|null, inputTokens: number, outputTokens: number,
 *             surface: string, platform: string, conversationId: string|null,
 *             url: string|null, timestamp: string|null,
 *             userEmail?: string }} TurnData
 */

/**
 * Builds the Langfuse ingestion batch for a single assistant turn.
 * Returns an array of { id, type, timestamp, body } objects.
 *
 * @param {TurnData} turn
 * @param {string} userId
 * @returns {Array<Record<string, unknown>>}
 */
export function buildTurnBatch(turn, userId) {
  const convId = turn.conversationId ?? crypto.randomUUID();
  const traceId = `claude-web-${convId}`;
  const now = turn.timestamp ?? new Date().toISOString();
  const cost = estimateCost(turn.model, turn.inputTokens, turn.outputTokens);

  const tags = [
    `surface:${turn.surface}`,
    `platform:${turn.platform}`,
    "entrypoint:claude-ai",
    `tier:${turn.platform === "app" ? "claude-app" : "claude-web"}`,
    "tier-source:browser-extension",
  ];

  return [
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
    {
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        id: `${traceId}-${now}`,
        traceId,
        name: turn.model ?? "claude-web",
        model: turn.model ?? "unknown",
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
}
