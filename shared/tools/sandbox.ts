/**
 * shared/tools/sandbox.ts — Sandbox wrapper para AgentTools
 *
 * Patrón Orvian agentic-coordinator#6. Envuelve cualquier AgentTool con un
 * modo de sandbox que evita ejecutar la llamada real (HTTP a Langfuse, etc.).
 *
 * Modos (controlados via env LANGFUSE_BRIDGE_SANDBOX_MODE):
 *   - off (default)      → ejecuta normalmente.
 *   - echo               → devuelve el input dentro de un wrapper { echoed: input }.
 *                          Para verificar conectividad sin tocar Langfuse.
 *   - fixture            → devuelve respuesta pre-registrada por tool.name.
 *                          Para tests deterministas en CI.
 *   - degradation        → devuelve un output con metadata.degradation poblado.
 *                          Para validar que el consumer maneja respuestas
 *                          parciales / con gaps de evidencia.
 *
 * Activación SOLO via env — los inputs de la tool no exponen el modo, así
 * un integrador no puede activarlo accidentalmente desde producción.
 */

import type { AgentTool } from "./types";

export type SandboxMode = "off" | "echo" | "fixture" | "degradation";

export interface SandboxedExecutionOutput {
  __sandbox: SandboxMode;
  input?: unknown;
  fixture?: unknown;
  degradation?: Array<{
    field: string;
    reason: string;
    impact: string;
    severity: "low" | "medium" | "high";
  }>;
}

/**
 * Lee el modo activo desde el entorno. Default: "off".
 * Valores no reconocidos también caen a "off" (fail-safe).
 */
export function getSandboxMode(
  env: NodeJS.ProcessEnv = process.env,
): SandboxMode {
  const raw = env["LANGFUSE_BRIDGE_SANDBOX_MODE"];
  switch (raw) {
    case "echo":
    case "fixture":
    case "degradation":
      return raw;
    default:
      return "off";
  }
}

/**
 * Registry de fixtures por nombre de tool. El consumer puede ampliar este
 * mapa antes de envolver una tool en sandbox; o registrar fixtures propias
 * vía registerFixture().
 */
const fixtureRegistry = new Map<string, unknown>();

/**
 * Mutex per-tool para serializar ejecuciones concurrentes (S20-D / GAP H5-B).
 *
 * Problema: dos agentes que llaman a la misma tool simultáneamente pueden
 * producir writes concurrentes a Langfuse o al sistema de archivos.
 * Solución: cola de Promises por nombre de tool — cada ejecución se encola
 * detrás de la anterior y espera a que resuelva antes de comenzar.
 *
 * Solo aplica en modo "off" (ejecución real). Los modos sandbox no tienen
 * estado compartido que proteger.
 */
const executionQueue = new Map<string, Promise<void>>();

function withMutex<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  const prev = executionQueue.get(toolName) ?? Promise.resolve();
  let resolveSlot!: () => void;
  const slot = new Promise<void>((res) => {
    resolveSlot = res;
  });
  executionQueue.set(toolName, slot);
  return prev.then(() => fn()).finally(resolveSlot);
}

/** Limpia la cola de un tool (útil en tests para resetear estado entre casos). */
export function clearExecutionQueue(toolName?: string): void {
  if (toolName) {
    executionQueue.delete(toolName);
  } else {
    executionQueue.clear();
  }
}

export function registerFixture(toolName: string, fixture: unknown): void {
  fixtureRegistry.set(toolName, fixture);
}

export function clearFixtures(): void {
  fixtureRegistry.clear();
}

const DEFAULT_DEGRADATION: NonNullable<
  SandboxedExecutionOutput["degradation"]
> = [
  {
    field: "metadata",
    reason: "sandbox-degradation-mode",
    impact: "data_skipped",
    severity: "medium",
  },
];

/**
 * Envuelve una tool con sandbox. Si el modo es "off", devuelve la tool original.
 * Si no, devuelve una nueva tool con el mismo contrato pero un execute() que
 * cortocircuita.
 */
export function withSandbox<TInput, TOutput>(
  tool: AgentTool<TInput, TOutput>,
  modeOverride?: SandboxMode,
): AgentTool<TInput, TOutput | SandboxedExecutionOutput> {
  const mode = modeOverride ?? getSandboxMode();
  if (mode === "off") {
    // En modo real, envolvemos execute() con el mutex per-tool para serializar
    // writes concurrentes (S20-D). El contrato de la tool no cambia.
    return {
      ...tool,
      async execute(input, ctx) {
        return withMutex(tool.name, () => tool.execute(input, ctx));
      },
    };
  }

  return {
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    inputSchema: tool.inputSchema,
    allowedAgentTypes: tool.allowedAgentTypes,
    validate: tool.validate,
    async execute(input, _ctx) {
      switch (mode) {
        case "echo":
          return {
            __sandbox: "echo",
            input,
          } as SandboxedExecutionOutput;
        case "fixture": {
          const fix = fixtureRegistry.get(tool.name);
          if (fix === undefined) {
            throw new Error(
              `[sandbox:fixture] no fixture registered for tool '${tool.name}'`,
            );
          }
          return {
            __sandbox: "fixture",
            fixture: fix,
          } as SandboxedExecutionOutput;
        }
        case "degradation":
          return {
            __sandbox: "degradation",
            degradation: DEFAULT_DEGRADATION,
          } as SandboxedExecutionOutput;
        default:
          // Should never reach — mode === "off" handled above.
          return tool.execute(input, _ctx);
      }
    },
  };
}

/**
 * Envuelve una lista entera de tools. Útil al construir un toolset desde el
 * registry: `listToolsForAgent(agent).map(withSandbox)` — cada tool respeta
 * el modo activo del entorno.
 */
export function withSandboxAll<T extends AgentTool<unknown, unknown>>(
  tools: readonly T[],
  modeOverride?: SandboxMode,
): Array<AgentTool<unknown, unknown>> {
  return tools.map((t) => withSandbox(t, modeOverride));
}
