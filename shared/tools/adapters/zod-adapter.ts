/**
 * shared/tools/adapters/zod-adapter.ts — AgentTool → AI SDK v6 tool
 *
 * AI SDK v6 espera tools con shape `{ description, inputSchema: ZodObject, execute }`.
 * Este adapter convierte un AgentTool (cuyo inputSchema es JSON-schema-like, sin
 * dependencias) a esa shape importando Zod dinámicamente.
 *
 * Zod NO es dep del proyecto base — el consumer que use este adapter debe
 * tenerlo en su propio package.json. Lanzamos error claro si falta.
 */

import type {
  AgentTool,
  JsonSchemaObject,
  JsonSchemaProperty,
  ToolContext,
} from "../types";

// Tipo opaco para el ZodSchema — evitamos depender del tipo de zod en compile time.
export type ZodSchema = unknown;

/**
 * Forma compatible con AI SDK v6 `tool({...})`.
 */
export interface AiSdkTool {
  description: string;
  inputSchema: ZodSchema;
  execute: (input: unknown) => Promise<unknown>;
}

interface ZodModule {
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => unknown;
    number: () => unknown;
    boolean: () => unknown;
    array: (item: unknown) => unknown;
    enum: <T extends readonly [string, ...string[]]>(values: T) => unknown;
    union: (schemas: unknown[]) => unknown;
  };
}

/**
 * Carga zod desde el consumer. Lanza un error explícito si no está instalado.
 * La función es async porque dynamic `import()` lo es.
 */
async function loadZod(): Promise<ZodModule["z"]> {
  try {
    const mod = (await import("zod")) as unknown as ZodModule;
    return mod.z;
  } catch {
    throw new Error(
      "[zod-adapter] zod is required but not installed in consumer. Add `zod` to your package.json.",
    );
  }
}

function propertyToZod(
  prop: JsonSchemaProperty,
  z: ZodModule["z"],
  required: boolean,
): unknown {
  let schema: unknown;
  switch (prop.type) {
    case "string":
      if (prop.enum && prop.enum.length > 0) {
        schema = z.enum(prop.enum as readonly [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      if (!prop.items) {
        throw new Error("[zod-adapter] array property missing 'items' schema");
      }
      schema = z.array(propertyToZod(prop.items, z, true));
      break;
    case "object":
      // Nested objects no soportados por ahora — los tools actuales no los usan.
      throw new Error(
        "[zod-adapter] nested object properties not supported yet",
      );
    default:
      throw new Error(
        `[zod-adapter] unknown property type: ${(prop as any).type}`,
      );
  }
  if (!required) {
    schema = (schema as { optional: () => unknown }).optional();
  }
  return schema;
}

/**
 * Convierte un JsonSchemaObject (forma del AgentTool) a un ZodObject.
 */
async function toZodObject(schema: JsonSchemaObject): Promise<ZodSchema> {
  const z = await loadZod();
  const required = new Set(schema.required ?? []);
  const shape: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    shape[key] = propertyToZod(prop, z, required.has(key));
  }
  return z.object(shape);
}

/**
 * Adapta un AgentTool a la forma consumible por AI SDK v6 `tool({...})`.
 *
 * El caller debe proveer un `ToolContext` (agentType, stepBudgetMs) que se
 * pasará a cada invocación. Si el contexto cambia entre calls, instanciar
 * un nuevo adapter por call.
 */
export async function toAiSdkTool<TInput, TOutput>(
  tool: AgentTool<TInput, TOutput>,
  ctx: ToolContext,
): Promise<AiSdkTool> {
  const inputSchema = await toZodObject(tool.inputSchema);
  return {
    description: tool.description,
    inputSchema,
    async execute(input: unknown) {
      const validated = tool.validate(input);
      if (!validated.ok) {
        throw new Error(`[${tool.name}] validation failed: ${validated.error}`);
      }
      return tool.execute(validated.data, ctx);
    },
  };
}

/**
 * Conveniencia: adapta TODAS las tools del registry para un agent dado.
 * Devuelve un `Record<toolName, AiSdkTool>` listo para `experimental_tools`.
 */
export async function buildAiSdkToolset(
  tools: Array<AgentTool<any, any>>,
  ctx: ToolContext,
): Promise<Record<string, AiSdkTool>> {
  const out: Record<string, AiSdkTool> = {};
  for (const t of tools) {
    out[t.name] = await toAiSdkTool(t, ctx);
  }
  return out;
}
