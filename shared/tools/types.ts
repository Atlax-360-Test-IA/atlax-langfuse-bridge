/**
 * shared/tools/types.ts — Contrato canónico de tools agénticos
 *
 * Inspirado en el patrón Orvian agentic-coordinator.md#3. Cero deps runtime —
 * el shape es compatible con AI SDK v6, MCP SDK y la Claude API direct tool use.
 * Un adapter externo (en otro proyecto consumer) mapea AgentTool a la forma
 * nativa del runtime que use.
 *
 * Convenciones:
 *   - `name`: kebab-case, debe coincidir con la entry de HOOK_TIER_MAP.
 *   - `description`: imperativa, < 200 chars — la ve el modelo en el prompt.
 *   - `inputSchema`: forma JSON-schema-like (no dep Zod). Validación manual.
 *   - `execute`: recibe params ya validados + contexto de ejecución.
 *   - `allowedAgentTypes`: whitelist estricta — jamás usar array vacío (= allow-all).
 */

import type { ProcessingTier } from "../processing-tiers";

export type AgentType = "coordinator" | "trace-analyst" | "annotator";

export interface ToolContext {
  /** ID del agente que ejecuta (log correlation). */
  agentType: AgentType;
  /** Budget restante para esta ejecución en ms. */
  stepBudgetMs: number;
  /** Signal para abortar si se excede el budget global. */
  signal?: AbortSignal;
}

export type ToolValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  required?: boolean;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  tier: ProcessingTier;
  inputSchema: JsonSchemaObject;
  allowedAgentTypes: readonly AgentType[];
  validate: (raw: unknown) => ToolValidationResult<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}
