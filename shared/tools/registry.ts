/**
 * shared/tools/registry.ts — Tool registry con access control
 *
 * Patrón Orvian agentic-coordinator#8: cada tool declara `allowedAgentTypes`.
 * El registry filtra por agent type — si un agent no está en la whitelist,
 * la tool literalmente no existe para él. No hay escalada de privilegios.
 *
 * Usar desde un consumer:
 *   const tools = listToolsForAgent("coordinator");
 *   // aplicar adapter a Zod/MCP según runtime
 */

import type { AgentTool, AgentType } from "./types";
import { queryLangfuseTrace } from "./query-langfuse-trace";
import { annotateObservation } from "./annotate-observation";

const REGISTRY: readonly AgentTool<any, any>[] = [
  queryLangfuseTrace,
  annotateObservation,
] as const;

/**
 * Lista todas las tools autorizadas para un agent type.
 */
export function listToolsForAgent(agentType: AgentType): AgentTool<any, any>[] {
  return REGISTRY.filter((t) => t.allowedAgentTypes.includes(agentType));
}

/**
 * Retrieve una tool por nombre. Retorna null si no existe o si el agent
 * no está autorizado.
 */
export function getTool(
  name: string,
  agentType: AgentType,
): AgentTool<any, any> | null {
  const t = REGISTRY.find((x) => x.name === name);
  if (!t) return null;
  if (!t.allowedAgentTypes.includes(agentType)) return null;
  return t;
}

/**
 * Lista todos los nombres de tools registradas — útil para docs/debug.
 * No aplica access control.
 */
export function listAllToolNames(): string[] {
  return REGISTRY.map((t) => t.name);
}
