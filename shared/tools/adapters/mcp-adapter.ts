/**
 * shared/tools/adapters/mcp-adapter.ts — AgentTool → MCP tool descriptor
 *
 * MCP (Model Context Protocol) usa JSON Schema standard en el campo
 * `inputSchema` de un tool descriptor. Nuestro `JsonSchemaObject` ya es
 * compatible — el mapper convierte el campo `required` (array de strings)
 * y normaliza props.
 *
 * Cero deps. El protocol layer (JSON-RPC stdio) está en scripts/mcp-server.ts.
 */

import type { AgentTool, JsonSchemaObject, JsonSchemaProperty } from "../types";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
}

export interface McpJsonSchema {
  type: "object";
  properties: Record<string, McpJsonSchemaProperty>;
  required: string[];
  additionalProperties?: boolean;
}

export interface McpJsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: McpJsonSchemaProperty;
}

function propertyToMcp(prop: JsonSchemaProperty): McpJsonSchemaProperty {
  const out: McpJsonSchemaProperty = { type: prop.type };
  if (prop.description !== undefined) out.description = prop.description;
  if (prop.enum !== undefined) out.enum = prop.enum;
  if (prop.items !== undefined) out.items = propertyToMcp(prop.items);
  return out;
}

function schemaToMcp(schema: JsonSchemaObject): McpJsonSchema {
  const properties: Record<string, McpJsonSchemaProperty> = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    properties[k] = propertyToMcp(v);
  }
  return {
    type: "object",
    properties,
    required: [...(schema.required ?? [])],
    additionalProperties: false,
  };
}

/**
 * Convierte un AgentTool al descriptor que MCP devuelve en `tools/list`.
 */
export function toMcpTool(tool: AgentTool<any, any>): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schemaToMcp(tool.inputSchema),
  };
}

export function toMcpToolset(
  tools: Array<AgentTool<any, any>>,
): McpToolDescriptor[] {
  return tools.map(toMcpTool);
}
